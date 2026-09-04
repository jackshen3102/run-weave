import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export type HttpUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => boolean;

export interface HttpUpgradeRouter {
  register: (handler: HttpUpgradeHandler) => void;
}

function rejectUnhandledUpgrade(socket: Duplex): void {
  if (!socket.destroyed) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  }
}

export function createHttpUpgradeRouter(server: HttpServer): HttpUpgradeRouter {
  const handlers: HttpUpgradeHandler[] = [];
  server.on("upgrade", (request, socket, head) => {
    for (const handler of handlers) {
      if (handler(request, socket, head)) return;
    }
    rejectUnhandledUpgrade(socket);
  });
  return {
    register: (handler) => {
      handlers.push(handler);
    },
  };
}
