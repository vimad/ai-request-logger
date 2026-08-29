import { preview, sha1 } from "./util.ts";

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  [key: string]: unknown;
}

export interface Message {
  role: string;
  content: string | ContentBlock[];
}

export interface AnthropicRequestBody {
  model?: string;
  system?: string | ContentBlock[];
  messages?: Message[];
  tools?: Array<{ name?: string }>;
  stream?: boolean;
  max_tokens?: number;
  thinking?: unknown;
  metadata?: { user_id?: string };
  [key: string]: unknown;
}

/**
 * `main`  - the agent loop that answers the user (carries the tool set).
 * `aux`   - Claude Code's background calls: conversation titles, topic
 *           detection, quota probes, compaction summaries. These must never
 *           open a new turn.
 * `other` - anything that is not a Messages API call (token counting, etc).
 */
export type RequestKind = "main" | "aux" | "other";

export interface RequestShape {
  sessionId: string;
  /** Set on requests issued by a subagent (Task tool), from x-claude-code-agent-id. */
  agentId?: string;
  parentAgentId?: string;
  kind: RequestKind;
  /** Stable identity of the user input that started the current turn. */
  turnKey: string;
  /** Short human label for the turn, taken from the user's own words. */
  turnLabel: string;
  model?: string;
  stream: boolean;
  messageCount: number;
  toolCount: number;
  toolNames: string[];
  systemChars: number;
  thinking: boolean;
  /** Text of the user message that opened the turn. */
  userText: string;
  /** Tool results being fed back in this request, if any. */
  toolResults: Array<{ tool_use_id?: string; is_error?: boolean; preview: string }>;
}

/**
 * Claude Code injects these into user messages. Their contents change from one
 * request to the next (open files, reminders, mode notices), so they must not
 * take part in identifying a turn - and they are not what the user typed.
 */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Prompts Claude Code writes to itself. They arrive as an ordinary user message
 * on a fully-loaded request - same model, same tool set, same metadata as a real
 * turn - so the synthetic opening line is the only thing that gives them away.
 * Being wrong here is cheap: the request is still logged, just folded into the
 * turn in flight instead of opening one of its own.
 */
const SYNTHETIC_PROMPTS = [/^\[SUGGESTION MODE:/i, /^\[No response requested/i];

function isSyntheticPrompt(text: string): boolean {
  const head = text.trimStart();
  return SYNTHETIC_PROMPTS.some((re) => re.test(head));
}

export function blocksOf(content: Message["content"]): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

export function textOf(content: Message["content"]): string {
  return blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** The user's own words: injected reminders stripped, empty blocks dropped. */
function promptBlocks(content: Message["content"]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocksOf(content)) {
    if (b.type !== "text") {
      out.push(b);
      continue;
    }
    const text = String(b.text ?? "").replace(SYSTEM_REMINDER, "").trim();
    if (text) out.push({ ...b, text });
  }
  return out;
}

/** True when the message is genuine user input rather than a tool-result hand-back. */
function isUserInput(message: Message): boolean {
  if (message.role !== "user") return false;
  if (blocksOf(message.content).some((b) => b.type === "tool_result")) return false;
  // A message that is nothing but an injected reminder is not the user speaking.
  return promptBlocks(message.content).length > 0;
}

/**
 * A stable identity for the message that opened the turn.
 *
 * Claude Code re-sends the same prompt in different shapes - `content` arrives
 * as an array of blocks on the first request and as a bare string on the
 * follow-ups - so hashing the raw JSON split one turn into several. Normalise
 * to block type plus text before hashing.
 */
function anchorFingerprint(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  return promptBlocks(content)
    .map((b) =>
      typeof b.text === "string" ? `text:${b.text.trim()}` : `${b.type}:${stableBlockId(b)}`,
    )
    .join("\n");
}

function stableBlockId(b: ContentBlock): string {
  const src = b.source as { media_type?: string; url?: string } | undefined;
  return [b.type, b.name, b.tool_use_id, src?.media_type, src?.url].filter(Boolean).join("/");
}

/**
 * Claude Code stamps every request with `x-claude-code-session-id`. Older
 * builds only carried the session inside `metadata.user_id`
 * (`user_<hash>_account_<uuid>_session_<uuid>`), so fall back to that, then to
 * a hash of the conversation prefix, rather than losing the grouping.
 */
export function sessionIdOf(body: AnthropicRequestBody, headers: Record<string, string>): string {
  const header = headers["x-claude-code-session-id"] ?? headers["x-session-id"];
  if (header) return header;

  const userId = body.metadata?.user_id;
  if (typeof userId === "string") {
    const m = /session[_-]([0-9a-fA-F-]{8,})/.exec(userId);
    if (m) return m[1]!;
    if (userId.length > 0) return sha1(userId).slice(0, 12);
  }

  const first = body.messages?.[0];
  if (first) return "anon-" + sha1(JSON.stringify(first.content)).slice(0, 10);
  return "anon-unknown";
}

export function describeRequest(
  body: AnthropicRequestBody,
  headers: Record<string, string>,
  isMessagesEndpoint: boolean,
): RequestShape {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  // The turn is anchored on the last real user input in the conversation.
  // Every follow-up request in the same turn only appends assistant/tool_result
  // messages after it, so the anchor stays put for the whole agent loop.
  let anchorIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserInput(messages[i]!)) {
      anchorIndex = i;
      break;
    }
  }
  const anchor = anchorIndex >= 0 ? messages[anchorIndex]! : undefined;
  const userText = anchor
    ? promptBlocks(anchor.content)
        .filter((b) => typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n")
    : "";

  const kind: RequestKind = !isMessagesEndpoint
    ? "other"
    : tools.length > 0 && !isSyntheticPrompt(userText)
      ? "main"
      : "aux";

  const last = messages[messages.length - 1];
  const toolResults = last
    ? blocksOf(last.content)
        .filter((b) => b.type === "tool_result")
        .map((b) => ({
          tool_use_id: b.tool_use_id,
          is_error: b.is_error === true,
          preview: preview(
            typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
            200,
          ),
        }))
    : [];

  const systemChars =
    typeof body.system === "string"
      ? body.system.length
      : Array.isArray(body.system)
        ? body.system.reduce((n, b) => n + (b.text?.length ?? 0), 0)
        : 0;

  return {
    sessionId: sessionIdOf(body, headers),
    agentId: headers["x-claude-code-agent-id"],
    parentAgentId: headers["x-claude-code-parent-agent-id"],
    kind,
    // Index is part of the key so an identical prompt asked twice is two turns.
    turnKey: `${anchorIndex}:${sha1(anchorFingerprint(anchor?.content)).slice(0, 16)}`,
    turnLabel: preview(userText, 48) || "(no user text)",
    model: body.model,
    stream: body.stream === true,
    messageCount: messages.length,
    toolCount: tools.length,
    toolNames: tools.map((t) => t.name ?? "?").filter(Boolean),
    systemChars,
    thinking: body.thinking != null,
    userText,
    toolResults,
  };
}
