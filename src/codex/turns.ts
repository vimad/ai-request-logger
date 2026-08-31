/**
 * Turn detection for the OpenAI Responses API as the Codex CLI drives it.
 *
 * Unlike Claude Code, Codex cleanly separates its own injected boilerplate
 * from the user's words: every request's `input` array carries at most one
 * `role: "user"` item that is the actual prompt (recommended-plugins and
 * environment-context noise arrives as an *earlier*, separate `user`-role
 * item). So the anchor is simply "the last `message` item with `role: "user"`
 * in the array" - no stripping required, unlike Claude's `<system-reminder>`.
 */
import type { RequestKind, RequestShape } from "../core/types.ts";
import { preview, sha1, tryParseJson } from "../core/util.ts";

export interface InputItem {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  output?: unknown;
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  tools?: unknown[];
  [key: string]: unknown;
}

export interface CodexRequestBody {
  model?: string;
  input?: InputItem[];
  stream?: boolean;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; context?: string };
  text?: { verbosity?: string };
  prompt_cache_key?: string;
  client_metadata?: { thread_id?: string; session_id?: string; turn_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Every request carries this as JSON in the `x-codex-turn-metadata` header
 * (and again, verbatim, inside `body.client_metadata`). `request_kind` is the
 * one field observed so far - `"turn"` for a real user-driven turn - so it is
 * what `kind` is built from; an unknown or absent value degrades to `aux`,
 * which just folds the request into the turn in flight rather than losing it.
 */
interface TurnMetadata {
  request_kind?: string;
  thread_source?: string;
  sandbox?: string;
  session_id?: string;
  thread_id?: string;
  [key: string]: unknown;
}

function turnMetadataOf(headers: Record<string, string>): TurnMetadata | undefined {
  const raw = headers["x-codex-turn-metadata"];
  if (!raw) return undefined;
  const parsed = tryParseJson(raw);
  return parsed && typeof parsed === "object" ? (parsed as TurnMetadata) : undefined;
}

function textOf(item: InputItem | undefined): string {
  if (!item) return "";
  return (item.content ?? [])
    .filter((c) => typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/** The last genuine user prompt - never the environment/plugin item ahead of it. */
function findAnchor(input: InputItem[]): { index: number; item: InputItem } | undefined {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]!;
    if (item.type === "message" && item.role === "user") return { index: i, item };
  }
  return undefined;
}

/**
 * Codex declares its tools as one `additional_tools` input item rather than a
 * top-level `tools` array, and nests a `collaboration` sub-agent namespace
 * inside it - so tools need a small recursive walk, not a flat map. Exported
 * so render.ts can walk the same structure to show full tool definitions,
 * not just their names.
 */
export function flattenTools(list: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (l: unknown): void => {
    if (!Array.isArray(l)) return;
    for (const t of l as Array<Record<string, unknown>>) {
      if (!t) continue;
      if (t.type === "namespace") walk(t.tools);
      else out.push(t);
    }
  };
  walk(list);
  return out;
}

function toolNamesOf(input: InputItem[]): string[] {
  const additional = input.find((item) => item.type === "additional_tools");
  return flattenTools(additional?.tools)
    .map((t) => t.name)
    .filter((n): n is string => typeof n === "string");
}

/**
 * The `session-id` / `thread-id` headers are what a real Codex CLI always
 * sends; `client_metadata` and `prompt_cache_key` are the same identity
 * carried in the body, kept as fallbacks for a client that only sets one.
 */
export function sessionIdOf(body: CodexRequestBody, headers: Record<string, string>): string {
  const header = headers["session-id"] ?? headers["thread-id"];
  if (header) return header;

  const meta = body.client_metadata;
  if (meta?.session_id) return meta.session_id;
  if (meta?.thread_id) return meta.thread_id;
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) return body.prompt_cache_key;
  return "anon-unknown";
}

/**
 * `x-codex-window-id` is `<thread_id>:<window_index>`; window `0` is the root
 * agent, so anything else is a sub-agent. Unconfirmed against a real spawned
 * sub-agent capture - being wrong here is cheap, per the provider contract:
 * a misclassified request just folds into the turn in flight.
 */
function agentIdOf(headers: Record<string, string>): string | undefined {
  const windowId = headers["x-codex-window-id"];
  if (!windowId) return undefined;
  const suffix = windowId.slice(windowId.lastIndexOf(":") + 1);
  return suffix && suffix !== "0" ? windowId : undefined;
}

/** The Codex-specific half of a `RequestShape`, carried in `detail`. */
export interface CodexDetail {
  toolCount: number;
  toolNames: string[];
  systemChars: number;
  reasoningEffort?: string;
  verbosity?: string;
  sandbox?: string;
  threadSource?: string;
  requestKind?: string;
  /** The tool result being fed back in this request, if any. */
  toolResult?: { callId?: string; preview: string };
  [key: string]: unknown;
}

export function describeRequest(
  body: CodexRequestBody,
  headers: Record<string, string>,
  isInference: boolean,
): RequestShape {
  const input = Array.isArray(body.input) ? body.input : [];
  const anchor = findAnchor(input);
  const anchorIndex = anchor?.index ?? -1;
  const userText = textOf(anchor?.item);

  const turnMeta = turnMetadataOf(headers);
  const kind: RequestKind = !isInference ? "other" : turnMeta?.request_kind === "turn" ? "main" : "aux";

  const toolNames = toolNamesOf(input);
  const systemChars = input
    .filter((item) => item.type === "message" && item.role === "developer")
    .reduce((n, item) => n + textOf(item).length, 0);

  const last = input[input.length - 1];
  const toolResult =
    last?.type === "custom_tool_call_output" || last?.type === "function_call_output"
      ? {
          callId: typeof last.call_id === "string" ? last.call_id : undefined,
          preview: preview(
            typeof last.output === "string" ? last.output : JSON.stringify(last.output ?? ""),
            200,
          ),
        }
      : undefined;

  return {
    sessionId: sessionIdOf(body, headers),
    agentId: agentIdOf(headers),
    kind,
    // Index is part of the key so an identical prompt asked twice is two turns.
    turnKey: `${anchorIndex}:${sha1(userText).slice(0, 16)}`,
    turnLabel: preview(userText, 48) || "(no user text)",
    model: body.model,
    stream: body.stream === true,
    messageCount: input.length,
    userText,
    detail: {
      toolCount: toolNames.length,
      toolNames,
      systemChars,
      reasoningEffort: body.reasoning?.effort,
      verbosity: body.text?.verbosity,
      sandbox: turnMeta?.sandbox,
      threadSource: turnMeta?.thread_source,
      requestKind: turnMeta?.request_kind,
      toolResult,
    } satisfies CodexDetail,
  };
}
