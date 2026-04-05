import http from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import { attachTerminalWebSocketServer } from "./terminal-server";

class FakeRuntime extends EventEmitter {
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly signal = vi.fn();
  readonly dispose = vi.fn();
  readonly pid = 123;

  onData(listener: (data: string) => void): void {
    this.on("data", listener);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.on("exit", listener);
  }
}

function createTerminalTicketVerification(resource: {
  terminalSessionId?: string;
}) {
  return {
    sessionId: "auth-session-1",
    username: "admin",
    tokenType: "terminal-ws" as const,
    resource,
  };
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

function closeSocket(socket: WebSocket): Promise<void> {
  if (
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
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

describe("terminal websocket server", () => {
  const servers: http.Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(
      sockets.map((socket) => closeSocket(socket).catch(() => undefined)),
    );
    sockets.length = 0;
    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("rejects unauthorized terminal websocket requests", async () => {
    const authService = {
      verifyTemporaryToken: vi.fn(() => null),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => undefined),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = {
      getRuntime: vi.fn(() => undefined),
      subscribe: vi.fn(() => () => undefined),
      attachClient: vi.fn(),
      detachClient: vi.fn(),
    };
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
    );
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=bad-token`,
    );
    sockets.push(socket);
    const closed = waitForClose(socket);

    expect((await closed).code).toBe(1008);
  });

  it("forwards input to PTY and output to the client", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (_token: string, params: { resource: { terminalSessionId?: string } }) =>
          createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        scrollback: "",
        status: "running",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
    });

    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "input", data: "pwd\n" }));
    runtime.emit("data", "/tmp/demo\n");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runtime.write).toHaveBeenCalledWith("pwd\n");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "connected", terminalSessionId: "terminal-1" }),
        expect.objectContaining({ type: "output", data: "/tmp/demo\n" }),
      ]),
    );
  });

  it("publishes terminal metadata updates from shell cwd markers", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (_token: string, params: { resource: { terminalSessionId?: string } }) =>
          createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        name: "/bin/zsh",
        cwd: "/tmp",
        scrollback: "",
        status: "running",
      })),
      updateSessionMetadata: vi.fn(async () => ({
        id: "terminal-1",
        name: "browser-hub",
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub",
        scrollback: "",
        status: "running",
      })),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
    });

    await waitForOpen(socket);
    runtime.emit(
      "data",
      "\u001b]7;file://localhost/Users/bytedance/Desktop/vscode/browser-hub\u0007",
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(terminalSessionManager.updateSessionMetadata).toHaveBeenCalledWith(
      "terminal-1",
      {
        name: "browser-hub",
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub",
      },
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "metadata",
          name: "browser-hub",
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub",
        }),
      ]),
    );
  });

  it("handles resize and signal messages", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (_token: string, params: { resource: { terminalSessionId?: string } }) =>
          createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        scrollback: "",
        status: "running",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);

    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    socket.send(JSON.stringify({ type: "signal", signal: "SIGINT" }));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runtime.resize).toHaveBeenCalledWith(120, 40);
    expect(runtime.signal).toHaveBeenCalledWith("SIGINT");
  });

  it("rejects unsupported app-layer ping messages", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (_token: string, params: { resource: { terminalSessionId?: string } }) =>
          createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        scrollback: "",
        status: "running",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
    });

    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "ping" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          message: "Invalid message",
        }),
      ]),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("replays persisted scrollback emitted before websocket attach", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (_token: string, params: { resource: { terminalSessionId?: string } }) =>
          createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        scrollback: "bash-3.2$ ",
        status: "running",
        exitCode: undefined,
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);

    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
    });

    await waitForOpen(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "output", data: "bash-3.2$ " }),
      ]),
    );
  });

  it("recreates a missing runtime for a persisted running session", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (_token: string, params: { resource: { terminalSessionId?: string } }) =>
          createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "",
        status: "running",
        exitCode: undefined,
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    const ptyService = {
      spawnSession: vi.fn(() => runtime),
    };

    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
      ptyService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);

    await waitForOpen(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ptyService.spawnSession).toHaveBeenCalledWith({
      command: "bash",
      args: ["-l"],
      cwd: "/tmp/demo",
    });
    expect(runtimeRegistry.getRuntime("terminal-1")).toBe(runtime);
  });

  it("isolates PTY runtime errors triggered by websocket input", async () => {
    const runtime = new FakeRuntime();
    runtime.write.mockImplementation(() => {
      throw new Error("write failed");
    });
    const authService = {
      verifyTemporaryToken: vi.fn(
        (_token: string, params: { resource: { terminalSessionId?: string } }) =>
          createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        scrollback: "",
        status: "running",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);

    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
    });

    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "input", data: "pwd\n" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining("write failed"),
        }),
      ]),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
