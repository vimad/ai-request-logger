import { createServer, type Server } from "node:http";
import type { Config } from "./config.ts";
import { LogStore } from "./logger.ts";
import { createHandler } from "./proxy.ts";

export interface ProxyServer {
  server: Server;
  store: LogStore;
}

/**
 * Builds the proxy server without starting it. Kept separate from the CLI so
 * tests can drive a real server on an ephemeral port.
 */
export function createProxyServer(cfg: Config, onLine: (line: string) => void = () => {}): ProxyServer {
  const store = new LogStore(cfg);
  const server = createServer(createHandler({ cfg, store, onLine }));

  // Agent clients hold long-lived streaming requests open while the model
  // thinks; none of the default socket timeouts may cut one short.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 120_000;

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return { server, store };
}
