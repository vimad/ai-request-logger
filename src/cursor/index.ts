/**
 * The Cursor CLI provider.
 *
 * Point the CLI at the proxy with its own endpoint flag - there is no base-URL
 * environment variable that the client reads on its own:
 *
 *     agent --endpoint http://127.0.0.1:8787
 *     CURSOR_API_ENDPOINT=http://127.0.0.1:8787 agent
 *
 * The agent stream is HTTP/2 by default, which a plain HTTP/1.1 reverse proxy
 * cannot carry. Set `network.useHttp1ForAgent: true` in `~/.cursor/cli-config.json`
 * first; the CLI then falls back to one-envelope-per-frame Connect streaming
 * over HTTP/1.1, which is what `messages.ts` reads.
 */
import type { DescribeInput, Provider, RequestShape, StreamFraming } from "../core/types.ts";
import { decodeStream, reconstructMessage, responseFacts } from "./messages.ts";
import { renderer } from "./render.ts";
import { APPEND_PATH, RUN_PATH, describeRequest } from "./turns.ts";

export const cursor: Provider = {
  id: "cursor",
  label: "Cursor CLI / Cursor agent API",
  defaultUpstream: "https://api2.cursor.sh",
  // The CLI takes `--endpoint`; this is the matching variable, for the banner.
  baseUrlEnvVar: "CURSOR_API_ENDPOINT",
  clientCommand: "agent",
  banner: {
    setup:
      'First put the CLI on HTTP/1.1, or it will bypass the proxy silently:\n' +
      '  ~/.cursor/cli-config.json -> { "network": { "useHttp1ForAgent": true } }',
    credentials:
      "Your Cursor login is untouched - credentials are forwarded verbatim,\n" +
      "  so `agent login`, API keys and team accounts all keep working.",
    backgroundTurn: "the agent run stream, opened before the first prompt",
  },

  isInferenceEndpoint: (path) => RUN_PATH.test(path) || APPEND_PATH.test(path),

  describeRequest(input: DescribeInput): RequestShape | undefined {
    return describeRequest(input);
  },

  /**
   * The agent stream announces `text/event-stream` but carries Connect
   * envelopes, not `data:` lines, so the core's SSE framing would find nothing.
   */
  streamFraming(headers: Record<string, string>): StreamFraming {
    const type = headers["content-type"] ?? "";
    if (type.includes("connect+") || type.includes("text/event-stream")) return "binary";
    return "none";
  },

  decodeStream,
  reconstructMessage,
  responseFacts,
  renderer,
};

export default cursor;
