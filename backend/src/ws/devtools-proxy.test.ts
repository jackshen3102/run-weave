import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { attachDevtoolsProxyServer } from "./devtools-proxy";

class FakeCDPSession {
  send = vi.fn(async (method: string) => {
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "target-1" } };
    }
    return undefined;
  });

  detach = vi.fn(async () => undefined);
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

describe("attachDevtoolsProxyServer", () => {
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

  it("rejects missing tabId", async () => {
    const authService = {
      verifyToken: vi.fn(() => true),
    };
    const sessionManager = {
      getSession: vi.fn(() => ({
        browserSession: {
          context: {
            newCDPSession: vi.fn(async () => new FakeCDPSession()),
          },
        },
      })),
    };

    const server = http.createServer();
    servers.push(server);
    attachDevtoolsProxyServer(
      server,
      sessionManager as never,
      authService as never,
      {
        enabled: true,
        remoteDebuggingPort: 9222,
      },
    );
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/devtools-proxy?sessionId=s-1&token=ok`,
    );
    sockets.push(socket);

    await waitForOpen(socket);
    const closeInfo = await waitForClose(socket);
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason.toString()).toBe("Missing tabId");
  });

  it("rejects when tab target cannot be resolved", async () => {
    const authService = {
      verifyToken: vi.fn(() => true),
    };
    const sessionManager = {
      getSession: vi.fn(() => ({
        browserSession: {
          context: {
            newCDPSession: vi.fn(async () => new FakeCDPSession()),
          },
        },
      })),
    };

    const server = http.createServer();
    servers.push(server);
    attachDevtoolsProxyServer(
      server,
      sessionManager as never,
      authService as never,
      {
        enabled: true,
        remoteDebuggingPort: 9222,
      },
    );
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/devtools-proxy?sessionId=s-1&token=ok&tabId=missing`,
    );
    sockets.push(socket);

    await waitForOpen(socket);
    const closeInfo = await waitForClose(socket);
    expect(closeInfo.code).toBe(1008);
    expect(closeInfo.reason.toString()).toBe("Target not found");
  });

  it("forwards messages in both directions", async () => {
    const upstreamHttp = http.createServer();
    servers.push(upstreamHttp);
    const upstreamWss = new WebSocketServer({ server: upstreamHttp });
    const upstreamPort = await startServer(upstreamHttp);

    upstreamWss.on("connection", (socket) => {
      socket.on("message", (data) => {
        socket.send(data);
      });
    });

    const authService = {
      verifyToken: vi.fn(() => true),
    };

    const fakeCdpSession = new FakeCDPSession();
    const fakePage = {};

    const sessionManager = {
      getSession: vi.fn((sessionId: string) => {
        if (sessionId !== "s-1") {
          return undefined;
        }
        return {
          browserSession: {
            context: {
              newCDPSession: vi.fn(async (page: unknown) => {
                if (page !== fakePage) {
                  throw new Error("unexpected page");
                }
                return fakeCdpSession;
              }),
            },
          },
        };
      }),
    };

    const contextModule = await import("./context");
    contextModule.registerSessionTabs("s-1", new Map([["tab-1", fakePage as never]]));

    const proxyHttp = http.createServer();
    servers.push(proxyHttp);
    attachDevtoolsProxyServer(
      proxyHttp,
      sessionManager as never,
      authService as never,
      {
        enabled: true,
        remoteDebuggingPort: upstreamPort,
      },
    );
    const proxyPort = await startServer(proxyHttp);

    const socket = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/ws/devtools-proxy?sessionId=s-1&token=ok&tabId=tab-1`,
    );
    sockets.push(socket);

    await waitForOpen(socket);

    const payload = JSON.stringify({ id: 1, method: "Runtime.enable" });
    socket.send(payload);

    const echoed = await new Promise<string>((resolve) => {
      socket.once("message", (data) => {
        resolve(String(data));
      });
    });

    expect(echoed).toBe(payload);
    expect(fakeCdpSession.send).toHaveBeenCalledWith("Target.getTargetInfo");
    contextModule.unregisterSessionTabs("s-1");
  });
});
