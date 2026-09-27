/**
 * The Claude Code half of the digest: Anthropic Messages API requests taken
 * apart into blobs. System blocks, tool definitions and message content
 * blocks are normalised (dropping the `cache_control` breakpoint that moves
 * every request, and the `caller` the API adds to a reply that the client
 * leaves out when it re-sends it) so a re-send hashes the same as the
 * original.
 */
import { tokens } from "../claude/render.ts";
import { blocksOf, type ContentBlock } from "../claude/turns.ts";
import { join } from "node:path";
import {
  oneLine,
  readStream,
  type BlobStore,
  type Category,
  type Purpose,
  type Ref,
  type RequestParts,
  type StreamBlock,
  type StreamSummary,
  type VizAdapter,
  type VizMessage,
} from "./model.ts";

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const SYNTHETIC = /^\s*\[(SUGGESTION MODE|No response requested)/i;

/** The first line of a reminder that says what it is about. */
function reminderLabel(text: string): string {
  const inner = text.replace(/<\/?system-reminder>/g, "").trim();
  const heading = /^#+\s*(.+)$/m.exec(inner);
  const first = inner.split("\n").find((l) => l.trim()) ?? "";
  return oneLine(heading && inner.indexOf(heading[0]) < 200 ? heading[1]! : first, 80);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c?.text === "string" ? c.text : c?.type === "image" ? "[image]" : JSON.stringify(c)))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content, null, 2);
}

/**
 * The fields that identify a block's content. Everything else - the
 * `cache_control` breakpoint that moves every request, the `caller` the API
 * adds to a response but the client drops on re-send - is transport.
 */
function normalise(b: ContentBlock): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text ?? "" };
    case "thinking":
      return { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: b.data ?? "" };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content ?? "", is_error: b.is_error === true };
    default: {
      const { cache_control: _c, caller: _k, ...rest } = b as Record<string, unknown>;
      return rest;
    }
  }
}

function classifyBlock(role: string, b: ContentBlock): Category {
  if (role === "system") return "reminder";
  switch (b.type) {
    case "text": {
      const text = String(b.text ?? "");
      if (role === "assistant") return "assistant";
      if (SYNTHETIC.test(text)) return "synthetic";
      const stripped = text.replace(SYSTEM_REMINDER, "").trim();
      if (!stripped) return "reminder";
      if (/^<(command-|local-command|bash-|task-notification)/.test(stripped)) return "reminder";
      return "prompt";
    }
    case "thinking":
    case "redacted_thinking":
      return "thinking";
    case "tool_use":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    case "image":
    case "document":
      return "media";
    default:
      return "other";
  }
}

function blockBlob(store: BlobStore, role: string, b: ContentBlock): Ref {
  const cat = classifyBlock(role, b);
  const norm = normalise(b);
  const id = store.put(cat, norm, () => {
    switch (b.type) {
      case "text": {
        const text = String(b.text ?? "");
        return { label: cat === "reminder" ? reminderLabel(text) : oneLine(text), text };
      }
      case "thinking": {
        const text = String(b.thinking ?? "");
        return {
          label: text ? oneLine(text) : "Thinking (content not returned to the client)",
          text: text || "(The API returned this thinking block with its text omitted; only the signature travels back.)",
        };
      }
      case "redacted_thinking":
        return { label: "Redacted thinking", text: "(encrypted by the API)" };
      case "tool_use": {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const hint = typeof input.command === "string"
          ? input.command
          : typeof input.file_path === "string"
            ? input.file_path
            : typeof input.pattern === "string"
              ? input.pattern
              : typeof input.description === "string"
                ? input.description
                : JSON.stringify(input);
        return {
          label: `${b.name ?? "tool"}: ${oneLine(String(hint), 70)}`,
          text: JSON.stringify(input, null, 2),
          name: String(b.name ?? ""),
          toolUseId: typeof b.id === "string" ? b.id : undefined,
          json: input,
        };
      }
      case "tool_result": {
        const text = toolResultText(b.content);
        return {
          label: (b.is_error ? "Error: " : "") + (oneLine(text, 80) || "(empty output)"),
          text,
          toolUseId: b.tool_use_id,
          isError: b.is_error === true,
        };
      }
      case "image":
      case "document": {
        const src = (b.source ?? {}) as { media_type?: string };
        return { label: `${b.type} · ${src.media_type ?? "?"}`, text: `[${b.type}: ${src.media_type ?? "unknown"}]` };
      }
      default:
        return { label: String(b.type), text: JSON.stringify(b, null, 2) };
    }
  });
  return b.cache_control ? { b: id, cache: true } : { b: id };
}

/** Why Claude Code made this call. The teaching value is in the `explain`. */
function purposeOf(req: any, res: any): Purpose {
  const shape = req?.shape ?? {};
  const body = req?.body ?? {};
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const system = typeof body.system === "string"
    ? body.system
    : Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").join("\n") : "";
  const last = messages[messages.length - 1];
  const lastText = last ? blocksOf(last.content).map((b) => (typeof b.text === "string" ? b.text : "")).join("\n") : "";
  const firstText = messages[0] ? blocksOf(messages[0].content).map((b) => (typeof b.text === "string" ? b.text : "")).join("\n") : "";

  if (shape.kind === "raw" || shape.kind === "other") {
    return {
      id: "plumbing",
      label: "API plumbing",
      explain: "Not an inference call. Claude Code talks to other endpoints too, for things like counting tokens or checking in.",
    };
  }
  if (shape.agentId) {
    return {
      id: "subagent",
      label: "Subagent",
      explain: "A subagent (spawned with the Agent tool) running its own loop. It starts from a fresh, smaller context and reports a summary back to the main thread.",
    };
  }
  if (shape.kind === "main") {
    return {
      id: "loop",
      label: "Agent loop",
      explain: "One lap of the agent loop: the whole conversation so far goes to the model, which answers with text or asks for tools.",
    };
  }
  if (firstText.trim() === "quota" || (body.max_tokens === 1 && messages.length === 1)) {
    return {
      id: "quota",
      label: "Quota check",
      explain: "A one-token probe Claude Code sends at startup to learn your rate-limit status. A 429 here just means \"you are near a limit\", read from the response headers.",
    };
  }
  if (/naming a coding session|title for (this|the) (conversation|session)/i.test(system) || /"title"\s*:/.test(JSON.stringify(res?.body?.content ?? ""))) {
    return {
      id: "title",
      label: "Session title",
      explain: "A small, tool-less call that names the session for the /resume list. It sees only your prompt, not the whole context.",
    };
  }
  if (/^\s*\[SUGGESTION MODE/i.test(lastText)) {
    return {
      id: "suggestion",
      label: "Next-prompt suggestion",
      explain: "After the turn ends, Claude Code asks the model to predict what you will type next, to offer it as a ghost suggestion. It re-sends the entire conversation to do it - and hits the prompt cache, so it is cheap.",
    };
  }
  if (/new conversation topic|isNewTopic/i.test(system + lastText)) {
    return {
      id: "topic",
      label: "Topic detection",
      explain: "Checks whether your message starts a new topic, so the terminal title can follow along.",
    };
  }
  if (/summar/i.test(lastText) && /(compact|conversation so far|context)/i.test(lastText + system)) {
    return {
      id: "compact",
      label: "Compaction",
      explain: "The context window is filling up, so the harness asks the model to summarise the conversation. The summary replaces the history in later requests.",
    };
  }
  if (/^\s*\[No response requested/i.test(lastText)) {
    return {
      id: "notice",
      label: "Background notice",
      explain: "A message the harness feeds the model without expecting a reply.",
    };
  }
  return {
    id: "background",
    label: "Background call",
    explain: "A call Claude Code makes on its own behalf, outside the main agent loop.",
  };
}

function streamSummary(path: string): StreamSummary | undefined {
  const events = readStream(path);
  if (!events) return undefined;
  const blocks = new Map<number, StreamBlock>();
  for (const { at, data: d } of events) {
    if (d.type === "content_block_start") {
      blocks.set(d.index, { index: d.index, type: d.content_block?.type ?? "?", start: at, end: at, deltas: 0 });
    } else if (d.type === "content_block_delta") {
      const b = blocks.get(d.index);
      if (b) {
        b.deltas++;
        b.end = at;
      }
    } else if (d.type === "content_block_stop") {
      const b = blocks.get(d.index);
      if (b) b.end = at;
    }
  }
  return {
    events: events.length,
    blocks: [...blocks.values()].sort((a, b) => a.index - b.index),
    firstEvent: events[0]?.at,
    lastEvent: events.at(-1)?.at,
  };
}

function request(store: BlobStore, req: any, res: any, reqDir: string): RequestParts {
  const shape = req.shape ?? {};
  const body = req.body && typeof req.body === "object" ? req.body : {};

  const system: Ref[] = [];
  const sysBlocks: ContentBlock[] = typeof body.system === "string"
    ? [{ type: "text", text: body.system }]
    : Array.isArray(body.system) ? body.system : [];
  sysBlocks.forEach((b, i) => {
    const text = String(b.text ?? "");
    const id = store.put("system", normalise(b), () => ({
      label: i === 0 && /billing-header/.test(text)
        ? "Billing header"
        : text.length < 120 ? oneLine(text) : `System prompt · ${oneLine(text, 60)}`,
      text,
    }));
    system.push(b.cache_control ? { b: id, cache: true } : { b: id });
  });

  const tools: Ref[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const { cache_control: _c, ...def } = t ?? {};
    const id = store.put("tools", def, () => ({
      label: String(def.name ?? def.type ?? "tool"),
      name: String(def.name ?? def.type ?? "tool"),
      text: String(def.description ?? ""),
      json: def.input_schema ?? def,
    }));
    tools.push(t?.cache_control ? { b: id, cache: true } : { b: id });
  }

  const messages: VizMessage[] = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = String(m?.role ?? "?");
    messages.push({ role, refs: blocksOf(m?.content).map((b) => blockBlob(store, role, b)) });
  }

  const resBody = res.body;
  const response: Ref[] = Array.isArray(resBody?.content)
    ? resBody.content.map((b: ContentBlock) => blockBlob(store, "assistant", b))
    : [];

  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k !== "system" && k !== "tools" && k !== "messages") params[k] = v;
  }

  return {
    system,
    tools,
    messages,
    response,
    responseRaw: response.length ? undefined : resBody,
    params,
    purpose: purposeOf(req, res),
    stop: res.stopReason,
    thinkingTokens: res.usage?.output_tokens_details?.thinking_tokens,
    stream_: shape.stream ? streamSummary(join(reqDir, "stream.jsonl")) : undefined,
  };
}

export const claudeViz: VizAdapter = {
  harness: {
    id: "claude",
    name: "Claude Code",
    api: "Claude API",
    stopField: "stop_reason",
    about: {},
  },
  tokens,
  request,
};
