import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { attachAiBridgeProxyServer } from "./ai-bridge-proxy";

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

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForClose(
  socket: WebSocket,
): Promise<{ code: number; reason: Buffer }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason });
    });
  });
}

describe("attachAiBridgeProxyServer", () => {
  const servers: http.Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            socket.once("close", () => resolve());
            socket.close();
          }),
      ),
    );
    sockets.length = 0;

    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("rejects when browser websocket endpoint cannot be resolved", async () => {
    const authService = {};
    const sessionManager = {
      getSession: vi.fn(() => ({
        browserSession: {},
      })),
      onAiBridgeConnected: vi.fn(),
      onAiMessage: vi.fn(),
      onAiBridgeDisconnected: vi.fn(),
      onAiBridgeError: vi.fn(),
    };

    const server = http.createServer();
    servers.push(server);
    attachAiBridgeProxyServer(
      server,
      sessionManager as never,
      authService as never,
      {
        resolveBrowserWebSocketUrl: vi.fn(async () => null),
      },
    );
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/ai-bridge?sessionId=s-1`,
    );
    sockets.push(socket);

    await waitForOpen(socket);
    const closeInfo = await waitForClose(socket);
    expect(closeInfo.code).toBe(1011);
    expect(closeInfo.reason.toString()).toBe("Browser websocket is unavailable");
  });

  it("forwards messages in both directions and records AI activity", async () => {
    const upstreamHttp = http.createServer();
    servers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({ server: upstreamHttp });
    const upstreamPort = await startServer(upstreamHttp);

    upstreamWss.on("connection", (socket) => {
      socket.on("message", (data) => {
        socket.send(data);
      });
    });

    const authService = {};
    const sessionManager = {
      getSession: vi.fn(() => ({
        browserSession: {},
      })),
      onAiBridgeConnected: vi.fn(),
      onAiMessage: vi.fn(),
      onAiBridgeDisconnected: vi.fn(),
      onAiBridgeError: vi.fn(),
    };

    const server = http.createServer();
    servers.push(server);
    attachAiBridgeProxyServer(
      server,
      sessionManager as never,
      authService as never,
      {
        resolveBrowserWebSocketUrl: vi.fn(
          async () => `ws://127.0.0.1:${upstreamPort}/devtools/browser/test`,
        ),
      },
    );
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/ai-bridge?sessionId=s-1`,
    );
    sockets.push(socket);

    await waitForOpen(socket);

    const payload = JSON.stringify({ id: 1, method: "Page.navigate" });
    socket.send(payload);

    const echoed = await new Promise<string>((resolve) => {
      socket.once("message", (data) => {
        resolve(String(data));
      });
    });

    expect(echoed).toBe(payload);
    expect(sessionManager.onAiBridgeConnected).toHaveBeenCalledWith("s-1");
    expect(sessionManager.onAiMessage).toHaveBeenCalledWith(
      "s-1",
      "Page.navigate",
    );
  });
});
