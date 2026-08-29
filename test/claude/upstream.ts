import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MockUpstream {
  origin: string;
  /** Every request the upstream saw, for asserting what the proxy forwarded. */
  seen: Array<{ method: string; url: string; headers: Record<string, string>; body: any }>;
  close: () => Promise<void>;
}

export interface MockOptions {
  /** Delay between streamed deltas, so buffering is detectable. */
  deltaDelayMs?: number;
}

/**
 * A stand-in for api.anthropic.com that speaks the parts of the wire protocol
 * the proxy has to survive: SSE with pings, tool_use with split
 * `input_json_delta`, gzip, and non-streaming JSON.
 */
export async function startMockUpstream(opts: MockOptions = {}): Promise<MockUpstream> {
  const delay = opts.deltaDelayMs ?? 12;
  const seen: MockUpstream["seen"] = [];

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { __unparsed: raw };
    }
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
      body,
    });

    if ((req.url ?? "").includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify({ input_tokens: 42 })));
      return;
    }

    if ((req.url ?? "").includes("/unauthorized")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error" } }));
      return;
    }

    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_ns",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "non-streaming reply" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      );
      return;
    }

    // A tool call is emitted unless the client just handed back a tool result,
    // which is what drives a multi-request turn.
    const last = body.messages?.at(-1);
    const isToolResult =
      Array.isArray(last?.content) && last.content.some((b: any) => b.type === "tool_result");
    const wantsTool = !isToolResult && (body.tools?.length ?? 0) > 0;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20 },
      },
    });
    res.write(": ping\n\n");
    send("ping", { type: "ping" });

    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    for (const t of ["Let me ", "check ", "that."]) {
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: t },
      });
      await sleep(delay);
    }
    send("content_block_stop", { type: "content_block_stop", index: 0 });

    if (wantsTool) {
      send("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      });
      // Split across deltas on purpose: reassembly is the thing under test.
      for (const p of ['{"comm', 'and":"ls', ' -la"}']) {
        send("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: p },
        });
        await sleep(delay);
      }
      send("content_block_stop", { type: "content_block_stop", index: 1 });
    }

    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: wantsTool ? "tool_use" : "end_turn" },
      usage: { output_tokens: 57 },
    });
    send("message_stop", { type: "message_stop" });
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no address");

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
