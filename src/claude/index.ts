/**
 * The Claude provider: everything that knows about Anthropic's wire format and
 * about how Claude Code in particular uses it (session headers, subagent ids,
 * injected system-reminders, the prompts it writes to itself).
 *
 * To add another provider, drop a sibling directory next to this one exporting
 * the same `Provider` object and register it in `src/providers.ts`. Nothing in
 * `src/core` needs to change.
 */
import type { DescribeInput, Provider, RequestShape } from "../core/types.ts";
import { reconstructMessage, responseFacts } from "./messages.ts";
import { renderer } from "./render.ts";
import { describeRequest, type AnthropicRequestBody } from "./turns.ts";

/** `/v1/messages`, with or without a query string, but not `/count_tokens`. */
const MESSAGES_PATH = /\/v1\/messages(?:\?|$)/;

export const claude: Provider = {
  id: "claude",
  label: "Claude Code / Anthropic Messages API",
  defaultUpstream: "https://api.anthropic.com",
  baseUrlEnvVar: "ANTHROPIC_BASE_URL",
  clientCommand: "claude",

  isInferenceEndpoint(path: string): boolean {
    return MESSAGES_PATH.test(path);
  },

  describeRequest({ body, headers, isInference }: DescribeInput): RequestShape | undefined {
    if (!body || typeof body !== "object") return undefined;
    return describeRequest(body as AnthropicRequestBody, headers, isInference);
  },

  reconstructMessage,
  responseFacts,
  renderer,
};

export default claude;
