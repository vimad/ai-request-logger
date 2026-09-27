/**
 * The Codex CLI half of the digest: OpenAI Responses API requests taken apart
 * into the same blobs the Claude digest produces.
 *
 * The Responses API has no `system` / `tools` / `messages` split. Everything
 * is one flat `input` array of typed items, so this maps it back:
 *
 * - `instructions`, and the `developer` messages at the head of `input`,
 *   are the system prompt. A developer message further down is the harness
 *   talking mid-conversation, so it stays in the conversation as injected
 *   context.
 * - The `additional_tools` item (and a top-level `tools`, if a build sends
 *   one) are the tool definitions, walked through `namespace` nesting.
 * - Every other item is one conversation entry, labelled `input[i]` so the
 *   page points at the real position in the body.
 *
 * Normalising drops `id` and `status`, which the stream attaches to an output
 * item and the client leaves off when it replays that item as input, so the
 * model's reply and its re-send hash the same.
 */
import { join } from "node:path";
import { tokens } from "../codex/render.ts";
import {
  bulletSkills,
  oneLine,
  PLUMBING,
  readStream,
  type BlobStore,
  type Category,
  type Purpose,
  type Ref,
  type RequestParts,
  type Skill,
  type Stop,
  type StreamBlock,
  type StreamSummary,
  type VizAdapter,
  type VizMessage,
} from "./model.ts";

type Item = Record<string, any>;

const TOOL_CALLS = new Set(["custom_tool_call", "function_call", "local_shell_call"]);
const TOOL_OUTPUTS = new Set(["custom_tool_call_output", "function_call_output", "local_shell_call_output"]);

/**
 * User-role text that Codex wrote, not you: `<environment_context>`,
 * `<recommended_plugins>` and friends (text that is nothing but tagged
 * blocks), and the AGENTS.md preamble.
 */
const TAGGED_ONLY = /^\s*(?:<([\w-]+)[^>]*>[\s\S]*?<\/\1>\s*)+$/;
const AGENTS_MD = /^\s*# AGENTS\.md instructions/;

function isInjected(text: string): boolean {
  return TAGGED_ONLY.test(text) || AGENTS_MD.test(text);
}

function injectedLabel(text: string): string {
  const tag = /^\s*<([\w-]+)/.exec(text)?.[1];
  if (!tag) return oneLine(text.split("\n").find((l) => l.trim()) ?? "", 80);
  const inner = text.replace(/<\/?[\w-]+[^>]*>/g, " ");
  return oneLine(`${tag} · ${inner}`, 80);
}

function partsOf(content: unknown): Item[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return Array.isArray(content) ? content.filter((c) => c && typeof c === "object") : [];
}

function textOf(content: unknown): string {
  return partsOf(content)
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** A tool's output, which may be a string, content parts, or JSON in a string. */
function outputText(output: unknown): { text: string; shown: string; isError: boolean } {
  if (typeof output !== "string") {
    const text = Array.isArray(output) ? textOf(output) : JSON.stringify(output ?? "", null, 2);
    return { text, shown: text, isError: false };
  }
  // Older builds wrap shell output as {"output": "...", "metadata": {"exit_code": n}}.
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object" && typeof parsed.output === "string") {
      const code = parsed.metadata?.exit_code;
      return { text: output, shown: parsed.output, isError: typeof code === "number" && code !== 0 };
    }
  } catch {}
  return { text: output, shown: output, isError: false };
}

/** A short hint of what a tool call does, for its one-line label. */
function callHint(item: Item): string {
  if (item.type === "custom_tool_call") {
    const input = String(item.input ?? "");
    // `exec` takes a script; the command it runs is the useful part.
    const cmd = /\b(?:cmd|command)\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(input)?.[2];
    return cmd ?? input.split("\n").find((l) => l.trim()) ?? "";
  }
  let args: any = item.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return args;
    }
  }
  const command = args?.command ?? item.action?.command;
  if (Array.isArray(command)) return String(command.length === 3 && /sh$/.test(command[0]) ? command[2] : command.join(" "));
  for (const k of ["command", "cmd", "file_path", "path", "query", "pattern", "message"]) {
    if (typeof args?.[k] === "string") return args[k];
  }
  return JSON.stringify(args ?? {});
}

function normalise(item: Item): Record<string, unknown> {
  switch (item.type) {
    case "reasoning":
      return {
        type: "reasoning",
        summary: item.summary ?? [],
        content: item.content ?? null,
        encrypted_content: item.encrypted_content ?? null,
      };
    case "custom_tool_call":
      return { type: item.type, call_id: item.call_id, name: item.name, input: item.input ?? "" };
    case "function_call":
      return { type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments ?? "" };
    default: {
      const { id: _i, status: _s, ...rest } = item;
      return rest;
    }
  }
}

/**
 * The skills list Codex injects in `<skills_instructions>`, under
 * `### Available skills`: `- name: description (file: /path/SKILL.md)`.
 */
function codexSkills(text: string): Skill[] | undefined {
  if (!/^\s*<skills_instructions>/.test(text)) return undefined;
  const head = /^### Available skills\s*$/m.exec(text);
  if (!head) return undefined;
  const list = text.slice(head.index + head[0].length).split(/^#{1,3} |<\/skills_instructions>/m)[0]!;
  const skills = bulletSkills(list);
  return skills.length ? skills : undefined;
}

/** One content part of a `message` item. */
function partBlob(store: BlobStore, role: string, part: Item): Ref {
  const isText = typeof part.text === "string";
  const text = isText ? String(part.text) : "";
  const cat: Category =
    !isText ? (/image|file/.test(String(part.type)) ? "media" : "other")
    : role === "assistant" ? "assistant"
    : role === "developer" || role === "system" ? "reminder"
    : isInjected(text) ? "reminder"
    : "prompt";
  const norm = isText ? { type: "text", text } : part;
  return {
    b: store.put(cat, norm, () =>
      isText
        ? cat === "reminder"
          ? { label: injectedLabel(text), text, ...(codexSkills(text) ? { skills: codexSkills(text) } : {}) }
          : { label: oneLine(text), text }
        : { label: String(part.type ?? "part"), text: JSON.stringify(part, null, 2) },
    ),
  };
}

/** Any non-message item: reasoning, a tool call, a tool's output. */
function itemBlob(store: BlobStore, item: Item): Ref {
  const type = String(item.type ?? "?");
  const cat: Category =
    type === "reasoning" ? "thinking"
    : TOOL_CALLS.has(type) ? "tool_use"
    : TOOL_OUTPUTS.has(type) ? "tool_result"
    : "other";
  const id = store.put(cat, normalise(item), () => {
    if (cat === "thinking") {
      const summary = textOf(item.summary);
      const content = textOf(item.content);
      const text = [summary, content].filter(Boolean).join("\n\n");
      return {
        label: summary ? oneLine(summary) : item.encrypted_content ? "Reasoning (encrypted)" : "Reasoning",
        text: text || "(The API returned this reasoning encrypted; only the ciphertext travels back, and Codex replays it on the next request.)",
      };
    }
    if (cat === "tool_use") {
      const name = String(item.name ?? type);
      const text = type === "custom_tool_call"
        ? String(item.input ?? "")
        : (() => {
            try {
              return JSON.stringify(typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments ?? item.action ?? {}, null, 2);
            } catch {
              return String(item.arguments);
            }
          })();
      return { label: `${name}: ${oneLine(callHint(item), 70)}`, text, name, toolUseId: item.call_id };
    }
    if (cat === "tool_result") {
      const out = outputText(item.output);
      return {
        label: (out.isError ? "Error: " : "") + (oneLine(out.shown, 80) || "(empty output)"),
        text: out.shown,
        toolUseId: item.call_id,
        isError: out.isError,
      };
    }
    return { label: type, text: JSON.stringify(item, null, 2) };
  });
  return { b: id };
}

/** The role a non-message item speaks with, for grouping and colour. */
function roleOf(item: Item): string {
  if (item.type === "message") return String(item.role ?? "?");
  if (item.type === "reasoning" || TOOL_CALLS.has(item.type)) return "assistant";
  if (TOOL_OUTPUTS.has(item.type)) return "tool";
  return String(item.role ?? item.type ?? "?");
}

function itemRefs(store: BlobStore, item: Item): Ref[] {
  return item.type === "message"
    ? partsOf(item.content).map((p) => partBlob(store, roleOf(item), p))
    : [itemBlob(store, item)];
}

/** Tool definitions, flattened through `namespace` entries, keeping the namespace. */
function toolDefs(list: unknown, ns?: string, out: Array<{ def: Item; ns?: string }> = []) {
  if (!Array.isArray(list)) return out;
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "namespace") toolDefs(t.tools, String(t.name ?? ns ?? "namespace"), out);
    else out.push({ def: t, ns });
  }
  return out;
}

function purposeOf(req: any): Purpose {
  const shape = req?.shape ?? {};
  if (shape.kind === "raw" || shape.kind === "other" || !shape.kind) {
    return { ...PLUMBING, explain: "Not an inference call. Codex talks to other endpoints too, for things like listing the models your account can use." };
  }
  if (shape.agentId) {
    return {
      id: "subagent",
      label: "Subagent",
      explain: "A sub-agent (spawned through the collaboration tools) running its own loop in its own window. It starts from a fresh, smaller context and reports back to the main thread.",
    };
  }
  if (shape.kind === "main") {
    return {
      id: "loop",
      label: "Agent loop",
      explain: "One lap of the agent loop: the whole conversation so far goes to the model, which answers with text or asks for tools.",
    };
  }
  const kind = typeof shape.requestKind === "string" ? shape.requestKind : undefined;
  if (kind && /compact/i.test(kind)) {
    return {
      id: "compact",
      label: "Compaction",
      explain: "The context window is filling up, so Codex asks the model to summarise the conversation. The summary replaces the history in later requests.",
    };
  }
  return {
    id: "background",
    label: "Background call",
    explain: `A call Codex makes on its own behalf, outside the main agent loop${kind ? ` (it tags it request_kind "${kind}")` : ""}.`,
  };
}

const BLOCK_TYPE: Record<string, string> = {
  message: "text",
  reasoning: "thinking",
  custom_tool_call: "tool_use",
  function_call: "tool_use",
  local_shell_call: "tool_use",
};

/** One bar per output item: when it opened, how many deltas, when it closed. */
function streamSummary(path: string): StreamSummary | undefined {
  const events = readStream(path);
  if (!events) return undefined;
  const blocks = new Map<number, StreamBlock>();
  for (const { at, event, data } of events) {
    const name = String(event ?? data.type ?? "");
    const index = data.output_index;
    if (typeof index !== "number") continue;
    let b = blocks.get(index);
    if (!b) {
      const type = String(data.item?.type ?? "?");
      b = { index, type: BLOCK_TYPE[type] ?? type, start: at, end: at, deltas: 0 };
      blocks.set(index, b);
    }
    if (name.endsWith(".delta")) b.deltas++;
    b.end = at;
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
  const input: Item[] = Array.isArray(body.input) ? body.input.filter((x: unknown) => x && typeof x === "object") : [];

  const system: Ref[] = [];
  if (typeof body.instructions === "string" && body.instructions) {
    const text = body.instructions;
    system.push({
      b: store.put("system", { instructions: text }, () => ({ label: `instructions · ${oneLine(text, 60)}`, text })),
    });
  }

  const tools: Ref[] = [];
  const addTools = (list: unknown) => {
    for (const { def, ns } of toolDefs(list)) {
      const name = String(def.name ?? def.type ?? "tool");
      tools.push({
        b: store.put("tools", { ns, ...def }, () => ({
          label: ns ? `${ns}.${name}` : name,
          name,
          text: String(def.description ?? ""),
          json: def.parameters ?? def.format ?? def,
          group: ns ? `Namespace · ${ns}` : undefined,
        })),
      });
    }
  };
  addTools(body.tools);

  const messages: VizMessage[] = [];
  let head = true;
  input.forEach((item, i) => {
    if (item.type === "additional_tools") return addTools(item.tools);
    const role = roleOf(item);
    if (head && item.type === "message" && (role === "developer" || role === "system")) {
      for (const part of partsOf(item.content)) {
        const text = typeof part.text === "string" ? part.text : JSON.stringify(part);
        system.push({
          b: store.put("system", { type: "text", text }, () => {
            const skills = codexSkills(text);
            return {
              label: skills ? `input[${i}] developer · Skills · ${skills.length} available` : `input[${i}] developer · ${oneLine(text, 60)}`,
              text,
              ...(skills ? { skills } : {}),
            };
          }),
        });
      }
      return;
    }
    head = false;
    messages.push({ role, refs: itemRefs(store, item), label: `input[${i}]` });
  });

  const resBody = res.body;
  const output: Item[] = Array.isArray(resBody?.output) ? resBody.output.filter((x: unknown) => x && typeof x === "object") : [];
  const response = output.flatMap((item) => itemRefs(store, item));

  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k !== "instructions" && k !== "input" && k !== "tools") params[k] = v;
  }

  const stop: Stop | undefined = output.some((it) => TOOL_CALLS.has(it.type))
    ? "tool_use"
    : res.stopReason === "completed" ? "end_turn" : res.stopReason;

  return {
    system,
    tools,
    messages,
    response,
    responseRaw: response.length ? undefined : resBody,
    params,
    purpose: purposeOf(req),
    stop,
    thinkingTokens: res.usage?.output_tokens_details?.reasoning_tokens || undefined,
    stream_: shape.stream ? streamSummary(join(reqDir, "stream.jsonl")) : undefined,
  };
}

export const codexViz: VizAdapter = {
  harness: {
    id: "codex",
    name: "Codex CLI",
    api: "OpenAI API",
    stopField: "status",
    skills: "Codex sends no skill tool. When the model decides a skill fits, it reads the skill's SKILL.md from the path in the list with an ordinary shell command.",
    about: {
      system: "Instructions Codex writes for the model: the `instructions` field and the developer messages at the head of the input. Who it is, the sandbox and approval rules, how to use its tools. You never see them, and they are sent in full with every request.",
      reminder: "Text Codex adds to the conversation for you: <environment_context> (working directory, shell, sandbox), AGENTS.md instructions, and developer messages part-way through. Each is its own input item, sent as \"user\" or \"developer\", but you never typed it.",
      thinking: "The model's reasoning. Codex asks for it back encrypted, so only ciphertext (and at most a short summary) reaches your machine. It replays that ciphertext on later requests so the model can pick up its own train of thought.",
      synthetic: "A whole prompt Codex wrote to the model on its own behalf, e.g. asking it to summarise the conversation when the context window fills up.",
      tool_use: "The model cannot run anything. It emits a tool call, usually one `exec` script that drives Codex's tools, and Codex runs it on your machine inside its sandbox.",
    },
  },
  tokens,
  request,
};
