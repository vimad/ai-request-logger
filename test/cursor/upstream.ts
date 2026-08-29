/**
 * A stand-in for api2.cursor.sh.
 *
 * It speaks the parts of the protocol the proxy has to survive, not the whole
 * service: Connect envelopes over an HTTP/1.1 response that calls itself
 * `text/event-stream`, per-frame gzip, a configurable delay between frames so
 * buffering is detectable, and unary `application/proto` replies for plumbing.
 */
import { createServer, type Server } from "node:http";
import { bytesField, endFrame, message, messageFrame, stateFrame } from "./encode.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MockUpstream {
  origin: string;
  seen: Array<{ method: string; url: string; headers: Record<string, string>; body: any }>;
  close: () => Promise<void>;
}

export interface MockOptions {
  /** Delay between streamed frames, so buffering is detectable. */
  deltaDelayMs?: number;
}

const ASSISTANT_TOOL_CALL = {
  id: "1",
  role: "assistant",
  content: [
    { type: "reasoning", text: "", signature: "sig" },
    { type: "tool-call", toolCallId: "c1", toolName: "Read", args: { path: "/tmp/note.txt" } },
  ],
};

const ASSISTANT_ANSWER = {
  id: "2",
  role: "assistant",
  content: [{ type: "text", text: "It says hello." }],
};

export async function startMockUpstream(opts: MockOptions = {}): Promise<MockUpstream> {
  const delay = opts.deltaDelayMs ?? 5;
  const seen: MockUpstream["seen"] = [];

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
      body: raw,
    });

    if ((req.url ?? "").includes("RunSSE")) {
      // The real service sends this content-type and then does not send SSE.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "connect-content-encoding": "gzip",
        "x-cursor-server-region": "us-east-1",
      });
      const stream = [
        messageFrame(1, { role: "system", content: "You are an AI coding assistant." }),
        messageFrame(2, { role: "user", content: "read note.txt" }),
        stateFrame(1200, 256000, [
          { id: "system_prompt", label: "System prompt", tokens: 700, chars: 2800 },
          { id: "tools", label: "Tool definitions", tokens: 500, chars: 2000 },
        ]),
        messageFrame(3, ASSISTANT_TOOL_CALL, { gzip: true }),
        messageFrame(4, { role: "tool", content: "hello" }),
        messageFrame(5, ASSISTANT_ANSWER),
        stateFrame(1800, 256000),
        endFrame({}),
      ];
      for (const frame of stream) {
        res.write(frame);
        await sleep(delay);
      }
      res.end();
      return;
    }

    // Everything else is a unary protobuf reply.
    res.writeHead(200, { "content-type": "application/proto" });
    res.end(message(bytesField(1, "ok")));
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
