import { createServer, type Server } from "node:http";

export interface MockUpstream {
  origin: string;
  seen: Array<{ method: string; url: string; headers: Record<string, string>; body: any }>;
  close: () => Promise<void>;
}

export interface MockOptions {
  /** Delay between streamed deltas, so buffering is detectable. */
  deltaDelayMs?: number;
}

/**
 * A stand-in for the real Codex backend: it streams SSE for `/responses`
 * without ever declaring `content-type` (the real quirk that forces this
 * provider's `streamFraming` override), and replies to `/models` with
 * ordinary JSON so the two are distinguishable.
 */
export async function startMockUpstream(opts: MockOptions = {}): Promise<MockUpstream> {
  const delay = opts.deltaDelayMs ?? 5;
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

    if ((req.url ?? "").startsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }] }));
      return;
    }

    if ((req.url ?? "").includes("/unauthorized")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid token" } }));
      return;
    }

    // A tool call is emitted unless the client just handed back a tool
    // result, which is what drives a multi-request turn.
    const last = Array.isArray(body.input) ? body.input.at(-1) : undefined;
    const isToolOutput = last?.type === "custom_tool_call_output";
    const input: any[] = Array.isArray(body.input) ? body.input : [];
    const hasTools = input.some((i) => i?.type === "additional_tools");
    const wantsTool = !isToolOutput && hasTools;

    // Deliberately no content-type header - matches the real backend.
    res.writeHead(200, {});
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    send("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } });

    let outputIndex = 0;
    if (wantsTool) {
      const item = { id: "fc_1", type: "custom_tool_call", status: "in_progress", call_id: "call_1", name: "exec" };
      send("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item });
      for (const p of ['const r = ', "await tools.exec_command(", '{cmd:"echo hi"})']) {
        send("response.output_item.delta", { type: "response.output_item.delta", output_index: outputIndex, delta: p });
        await sleep(delay);
      }
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { ...item, status: "completed", input: 'const r = await tools.exec_command({cmd:"echo hi"})' },
      });
      outputIndex++;
    } else {
      const item = { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] };
      send("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item });
      send("response.content_part.added", {
        type: "response.content_part.added",
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
      for (const t of ["Let me ", "check ", "that."]) {
        send("response.output_text.delta", {
          type: "response.output_text.delta",
          output_index: outputIndex,
          content_index: 0,
          delta: t,
        });
        await sleep(delay);
      }
      send("response.output_text.done", { type: "response.output_text.done", output_index: outputIndex, content_index: 0 });
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { ...item, status: "completed", content: [{ type: "output_text", text: "Let me check that." }] },
      });
      outputIndex++;
    }

    send("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        // The real ("lite") backend ships an empty output here on purpose;
        // reconstructMessage must fall back to the accumulated items.
        output: [],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
          output_tokens: wantsTool ? 40 : 10,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: wantsTool ? 160 : 130,
        },
      },
    });
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
