/**
 * Session and turn identity for the Cursor CLI.
 *
 * The CLI splits one conversation across two endpoints, which is what makes
 * this different from a request-per-turn API:
 *
 * - **`BidiService/BidiAppend`** - the client pushing events *up*: the user's
 *   prompt, tool results, cancellations. One unary call per event, numbered by
 *   a sequence field. The user's prompt lives here, so this is what opens a
 *   turn.
 * - **`AgentService/RunSSE`** - one long-lived response carrying the model's
 *   side of the whole run. It is opened *before* the first prompt is sent, so
 *   it cannot name the turn it belongs to; it is `aux` and folds into the turn
 *   in flight.
 *
 * Both are protobuf. The field numbers below were read off captured traffic,
 * not a schema, so every read is optional and a miss costs a label rather than
 * the capture.
 */
import { sha1 } from "../core/util.ts";
import type { DescribeInput, RequestShape } from "../core/types.ts";
import { decodeBodyEncoding, readEnvelopes } from "./connect.ts";
import { all, at, decodeMessage, hexMessage, numeric, one, str } from "./protobuf.ts";
import type { PbField } from "./protobuf.ts";

export const RUN_PATH = /\/agent\.v1\.AgentService\/RunSSE(?:\?|$)/;
export const APPEND_PATH = /\/aiserver\.v1\.BidiService\/BidiAppend(?:\?|$)/;

/**
 * What ties the two endpoints together.
 *
 * Neither endpoint names the session on its own: `RunSSE`'s body carries only
 * the id of that HTTP request, and the conversation id appears only on
 * `BidiAppend`. `x-blob-encryption-key` is the one value both send and one CLI
 * process keeps for its lifetime, so it identifies the session - hashed,
 * because it is a key and must not become a directory name.
 */
function sessionOf(headers: Record<string, string>): string | undefined {
  const blobKey = headers["x-blob-encryption-key"];
  if (blobKey) return `cli-${sha1(blobKey).slice(0, 12)}`;
  return headers["x-request-id"];
}

/** Field numbers inside the event blob carried by a BidiAppend. */
const EVENT = {
  /** Field 1 of an event is present only on a user turn. */
  userTurn: 1,
  prompt: [2, 1, 1, 1] as const,
  promptId: [2, 1, 1, 2] as const,
  runId: 5,
  model: [9, 1] as const,
  availableModel: 14,
  conversationId: 25,
};

export interface CursorRequest {
  kind: "run" | "append";
  fields: PbField[] | undefined;
  event?: PbField[];
}

/** Undo `content-encoding`, then read the body as protobuf or as envelopes. */
function readBody(bodyBuf: Buffer, headers: Record<string, string>): PbField[] | undefined {
  const buf = decodeBodyEncoding(bodyBuf, headers["content-encoding"]);
  if ((headers["content-type"] ?? "").includes("connect+")) {
    const first = readEnvelopes(buf, headers["connect-content-encoding"] ?? "gzip")[0];
    return first?.payload && decodeMessage(first.payload);
  }
  return decodeMessage(buf);
}

/** The prompt that opened this turn, when the event carries one. */
function promptOf(event: PbField[] | undefined): { text: string; id: string } | undefined {
  const turn = at(event, EVENT.userTurn)?.message;
  if (!turn) return undefined;
  const text = str(turn, ...EVENT.prompt);
  if (text === undefined || text.trim() === "") return undefined;
  return { text, id: str(turn, ...EVENT.promptId) ?? sha1(text).slice(0, 16) };
}

export function describeRequest({ bodyBuf, headers, path }: DescribeInput): RequestShape | undefined {
  if (RUN_PATH.test(path)) return describeRun(bodyBuf, headers);
  if (APPEND_PATH.test(path)) return describeAppend(bodyBuf, headers);
  // Dashboard, analytics and model-catalogue calls carry no conversation, so
  // they stay unstructured rather than inventing a session to sit in.
  return undefined;
}

/** `RunSSE`: the model's side of the run. Its body is just the run id. */
function describeRun(bodyBuf: Buffer, headers: Record<string, string>): RequestShape | undefined {
  const session = sessionOf(headers);
  if (!session) return undefined;
  const fields = readBody(bodyBuf, headers);
  // This is the id of the HTTP request that opened the stream, not the run's
  // own id - the run id only ever appears in the reply.
  const requestId = str(fields, 1) ?? headers["x-request-id"];
  return {
    sessionId: session,
    kind: "aux",
    turnKey: `run:${requestId ?? session}`,
    turnLabel: "agent run",
    stream: true,
    messageCount: 0,
    userText: "",
    detail: {
      endpoint: "RunSSE",
      requestId,
      clientType: headers["x-cursor-client-type"],
      clientVersion: headers["x-cursor-client-version"],
      ghostMode: headers["x-ghost-mode"] === "true",
    },
  };
}

/** `BidiAppend`: one client event. Only a user prompt opens a turn. */
function describeAppend(bodyBuf: Buffer, headers: Record<string, string>): RequestShape | undefined {
  const session = sessionOf(headers);
  const fields = readBody(bodyBuf, headers);
  if (!fields || !session) return undefined;

  const conversationId = str(fields, 2, 1);
  const seq = numeric(fields, 3) ?? 0;
  const event = hexMessage(one(fields, 1));
  const turn = at(event, EVENT.userTurn)?.message;
  const prompt = promptOf(event);

  const runId = str(turn, EVENT.runId);

  // The event's top-level field number is its type; naming the ones seen so
  // far keeps the log readable without pretending to know the whole schema.
  const eventFields = event?.map((f) => f.field) ?? [];

  const detail = {
    endpoint: "BidiAppend",
    conversationId,
    runId,
    seq,
    eventFields,
    promptChars: prompt?.text.length,
    availableModels: turn ? all(turn, EVENT.availableModel).length : undefined,
  };

  if (!prompt) {
    return {
      sessionId: session,
      kind: "aux",
      turnKey: `append:${session}`,
      turnLabel: "client events",
      stream: false,
      messageCount: seq,
      userText: "",
      detail,
    };
  }

  return {
    sessionId: session,
    kind: "main",
    // The prompt's own id is unique per message, so the same question asked
    // twice opens two turns - which is the behaviour the log wants.
    turnKey: `${seq}:${prompt.id}`,
    turnLabel: prompt.text,
    model: str(turn, ...EVENT.model),
    stream: false,
    messageCount: seq,
    userText: prompt.text,
    detail,
  };
}
