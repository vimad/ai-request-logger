/**
 * The Codex CLI provider: OpenAI's Responses API (`POST /responses`) as the
 * `codex` CLI drives it - full input replayed every request, "lite" SSE
 * streaming with no `content-type` header, and tool calls routed through a
 * single JS-orchestration "exec" tool rather than one function per tool.
 *
 * Codex refuses to let you override its built-in `openai` provider's
 * `base_url` ("model_providers contains reserved built-in provider IDs"), so
 * there is no env var this proxy can hand you - point Codex at it with a new
 * named provider instead, on every invocation:
 *
 *     codex -c model_providers.local.name="local" \
 *           -c model_providers.local.base_url="http://127.0.0.1:8787" \
 *           -c model_providers.local.wire_api="responses" \
 *           -c model_provider="local"
 *
 * Existing `codex login` (ChatGPT OAuth) or an API key auth mode is honoured
 * automatically by the new provider entry - nothing else changes.
 */
import type { DescribeInput, Provider, RequestShape, StreamFraming } from "../core/types.ts";
import { reconstructMessage, responseFacts } from "./messages.ts";
import { renderer } from "./render.ts";
import { describeRequest, type CodexRequestBody } from "./turns.ts";

/** `/responses`, with or without a query string, but not a sub-path. */
const RESPONSES_PATH = /\/responses(?:\?|$)/;

const INVOCATION =
  'codex -c model_providers.local.name="local" -c model_providers.local.base_url="{base}" ' +
  '-c model_providers.local.wire_api="responses" -c model_provider="local"';

export const codex: Provider = {
  id: "codex",
  label: "OpenAI Codex CLI / Responses API",
  defaultUpstream: "https://chatgpt.com/backend-api/codex",
  // Codex has no base-URL env var; `invocation` below is what the banner
  // actually prints. This is only a placeholder for the (unused) fallback line.
  baseUrlEnvVar: "CODEX_BASE_URL",
  clientCommand: "codex",
  banner: {
    setup:
      "Codex refuses to override its built-in `openai` provider's base_url, so\n" +
      "  a new named provider is defined and selected instead (see below).",
    invocation: (base) => INVOCATION.replace("{base}", base),
    credentials:
      "Your existing `codex login` (ChatGPT) or API key is forwarded verbatim -\n" +
      "  nothing is intercepted, so auth keeps working unchanged.",
    backgroundTurn: "plumbing calls such as /models",
  },

  isInferenceEndpoint: (path) => RESPONSES_PATH.test(path),

  describeRequest({ body, headers, isInference }: DescribeInput): RequestShape | undefined {
    if (!body || typeof body !== "object") return undefined;
    return describeRequest(body as CodexRequestBody, headers, isInference);
  },

  /**
   * The real backend streams SSE for `/responses` without ever declaring
   * `content-type: text/event-stream` (confirmed against a live capture), so
   * the core's content-type sniff finds nothing. Plumbing endpoints such as
   * `/models` reply with ordinary `application/json` - the one signal left to
   * tell the two apart.
   */
  streamFraming(headers: Record<string, string>): StreamFraming {
    return (headers["content-type"] ?? "").includes("json") ? "none" : "sse";
  },

  reconstructMessage,
  responseFacts,
  renderer,
};

export default codex;
