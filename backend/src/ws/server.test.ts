import http from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { attachWebSocketServer } from "./server";

class FakeCDPSession extends EventEmitter {
  send = vi.fn(async () => undefined);
  detach = vi.fn(async () => undefined);
}

function createJsonMessageQueue(socket: WebSocket) {
  const queue: Record<string, unknown>[] = [];
  const pendingResolvers: Array<(value: Record<string, unknown>) => void> = [];

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      return;
    }

    const parsed = JSON.parse(String(data)) as Record<string, unknown>;
    const resolver = pendingResolvers.shift();
    if (resolver) {
      resolver(parsed);
      return;
    }
    queue.push(parsed);
  });

  return {
    next: (): Promise<Record<string, unknown>> => {
      const ready = queue.shift();
      if (ready) {
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => pendingResolvers.push(resolve));
    },
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

async function startServer(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server port");
  }

  return address.port;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

describe("websocket server", () => {
  const servers: http.Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.map((socket) => closeSocket(socket).catch(() => undefined)));
    sockets.length = 0;

    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("accepts session and applies input to page", async () => {
    const cdpSession = new FakeCDPSession();
    const page = {
      mouse: {
        click: vi.fn(async () => undefined),
        move: vi.fn(async () => undefined),
        wheel: vi.fn(async () => undefined),
      },
      keyboard: {
        press: vi.fn(async () => undefined),
      },
    };

    const sessionManager = {
      getSession: vi.fn(() => ({
        id: "session-1",
        browserSession: {
          context: {
            newCDPSession: vi.fn(async () => cdpSession),
          },
          page,
        },
      })),
      markConnected: vi.fn(),
      destroySession: vi.fn(async () => true),
    };

    const server = http.createServer();
    servers.push(server);
    attachWebSocketServer(server, sessionManager as never);
    const port = await startServer(server);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=session-1`);
    sockets.push(socket);
    const queue = createJsonMessageQueue(socket);

    await waitForOpen(socket);
    const connectedMessage = await queue.next();
    expect(connectedMessage.type).toBe("connected");

    socket.send(JSON.stringify({ type: "mouse", action: "click", x: 11, y: 22, button: "left" }));
    const ackMessage = await queue.next();
    expect(ackMessage.type).toBe("ack");
    expect(page.mouse.click).toHaveBeenCalledWith(11, 22, { button: "left" });
  });

  it("returns error on invalid input payload", async () => {
    const cdpSession = new FakeCDPSession();
    const sessionManager = {
      getSession: vi.fn(() => ({
        id: "session-2",
        browserSession: {
          context: {
            newCDPSession: vi.fn(async () => cdpSession),
          },
          page: {
            mouse: {
              click: vi.fn(async () => undefined),
              move: vi.fn(async () => undefined),
              wheel: vi.fn(async () => undefined),
            },
            keyboard: {
              press: vi.fn(async () => undefined),
            },
          },
        },
      })),
      markConnected: vi.fn(),
      destroySession: vi.fn(async () => true),
    };

    const server = http.createServer();
    servers.push(server);
    attachWebSocketServer(server, sessionManager as never);
    const port = await startServer(server);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=session-2`);
    sockets.push(socket);
    const queue = createJsonMessageQueue(socket);

    await waitForOpen(socket);
    await queue.next();

    socket.send("{\"bad\":true}");
    const errorMessage = await queue.next();
    expect(errorMessage.type).toBe("error");
  });
});
