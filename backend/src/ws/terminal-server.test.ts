import http from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@browser-viewer/shared";
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

  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): void {
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
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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
        expect.objectContaining({
          type: "connected",
          terminalSessionId: "terminal-1",
        }),
        expect.objectContaining({ type: "output", data: "/tmp/demo\n" }),
      ]),
    );
  });

  it("batches adjacent PTY output chunks into a single websocket output event", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
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
    runtime.emit("data", "echo ");
    runtime.emit("data", "hello\n");

    await new Promise((resolve) => setTimeout(resolve, 50));

    const outputMessages = messages.filter(
      (message) => message.type === "output",
    );
    expect(outputMessages).toEqual([
      expect.objectContaining({
        type: "output",
        data: "echo hello\n",
      }),
    ]);
  });

  it("flushes the first PTY output chunk immediately after terminal input", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new FakeRuntime();
      runtime.write.mockImplementation((data: string) => {
        runtime.emit("data", data);
      });
      const authService = {
        verifyTemporaryToken: vi.fn(
          (
            _token: string,
            params: { resource: { terminalSessionId?: string } },
          ) => createTerminalTicketVerification(params.resource),
        ),
      };
      const terminalSessionManager = {
        getSession: vi.fn(() => ({
          id: "terminal-1",
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

      socket.send(JSON.stringify({ type: "input", data: "ls" }));
      await vi.waitFor(() => {
        expect(runtime.write).toHaveBeenCalledWith("ls");
      });
      await vi.waitFor(() => {
        const outputMessages = messages.filter(
          (message) => message.type === "output",
        );
        expect(outputMessages).toEqual([
          expect.objectContaining({
            type: "output",
            data: "ls",
          }),
        ]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes buffered PTY output before sending terminal exit events", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
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
    runtime.emit("data", "final line\n");
    runtime.emit("exit", { exitCode: 0 });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const outputIndex = messages.findIndex(
      (message) => message.type === "output" && message.data === "final line\n",
    );
    const exitIndex = messages.findIndex((message) => message.type === "exit");

    expect(outputIndex).toBeGreaterThan(-1);
    expect(exitIndex).toBeGreaterThan(outputIndex);
  });

  it("publishes terminal metadata updates from shell cwd markers", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        cwd: "/tmp",
        activeCommand: null,
        scrollback: "",
        status: "running",
      })),
      updateSessionMetadata: vi.fn(async () => ({
        id: "terminal-1",
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub",
        activeCommand: null,
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
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub",
        activeCommand: null,
      },
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "metadata",
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub",
          activeCommand: null,
        }),
      ]),
    );
  });

  it("publishes terminal metadata updates from foreground command markers", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        cwd: "/Users/bytedance/Desktop/vscode/browser-viewer",
        activeCommand: null,
        scrollback: "",
        status: "running",
      })),
      updateSessionMetadata: vi.fn(async () => ({
        id: "terminal-1",
        cwd: "/Users/bytedance/Desktop/vscode/browser-viewer",
        activeCommand: "codex",
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
    runtime.emit("data", "\u001b]633;BrowserViewerCommand=codex\u0007");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "metadata",
          cwd: "/Users/bytedance/Desktop/vscode/browser-viewer",
          activeCommand: "codex",
        }),
      ]),
    );
  });

  it("handles resize and signal messages", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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

  it("sends a snapshot of persisted scrollback when websocket attaches", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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

    expect(messages).toEqual([
      {
        type: "connected",
        terminalSessionId: "terminal-1",
        runtimeKind: "pty",
      },
      {
        type: "snapshot",
        data: "bash-3.2$ ",
      },
      {
        type: "status",
        status: "running",
      },
    ]);
  });

  it("limits websocket snapshot scrollback to the configured latest lines", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const scrollback = Array.from(
      { length: TERMINAL_CLIENT_SCROLLBACK_LINES + 250 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        scrollback,
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

    expect(messages).toEqual([
      {
        type: "connected",
        terminalSessionId: "terminal-1",
        runtimeKind: "pty",
      },
      {
        type: "snapshot",
        data: Array.from(
          { length: TERMINAL_CLIENT_SCROLLBACK_LINES },
          (_, index) =>
            `line-${index + (TERMINAL_CLIENT_SCROLLBACK_LINES + 250 - TERMINAL_CLIENT_SCROLLBACK_LINES + 1)}`,
        ).join("\n"),
      },
      {
        type: "status",
        status: "running",
      },
    ]);
  });

  it("skips the initial websocket snapshot when the client only watches live output", async () => {
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "large persisted transcript",
        status: "running",
        exitCode: undefined,
      })),
      getLiveScrollback: vi.fn(() => "large persisted transcript"),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateSessionLaunch: vi.fn(),
    };
    const runtime = new FakeRuntime();
    const runtimeRegistry = {
      getRuntime: vi.fn(() => runtime),
      ensureRecorder: vi.fn(),
      attachClient: vi.fn(),
      detachClient: vi.fn(),
      subscribe: vi.fn((_terminalSessionId, subscriber) => {
        subscriber.onData("live-only\n");
        return () => undefined;
      }),
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
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token&snapshot=0`,
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

    expect(terminalSessionManager.getLiveScrollback).not.toHaveBeenCalled();
    expect(messages).toEqual([
      {
        type: "connected",
        terminalSessionId: "terminal-1",
        runtimeKind: "pty",
      },
      {
        type: "status",
        status: "running",
      },
      {
        type: "output",
        data: "live-only\n",
      },
    ]);
  });

  it("flushes live output after the initial snapshot when output arrives during websocket attach", async () => {
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn().mockReturnValue({
        id: "terminal-1",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "bash-3.2$ ",
        status: "running",
        exitCode: undefined,
      }),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateSessionLaunch: vi.fn(),
    };
    const runtime = new FakeRuntime();
    const runtimeRegistry = {
      getRuntime: vi.fn(() => runtime),
      ensureRecorder: vi.fn(),
      attachClient: vi.fn(),
      detachClient: vi.fn(),
      subscribe: vi.fn((_terminalSessionId, subscriber) => {
        subscriber.onData("echo hi\n");
        return () => undefined;
      }),
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

    expect(messages).toEqual([
      {
        type: "connected",
        terminalSessionId: "terminal-1",
        runtimeKind: "pty",
      },
      {
        type: "snapshot",
        data: "bash-3.2$ ",
      },
      {
        type: "status",
        status: "running",
      },
      {
        type: "output",
        data: "echo hi\n",
      },
    ]);
  });

  it("recreates a missing runtime for a persisted running session", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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
      fallback: expect.objectContaining({
        command: expect.any(String),
        args: expect.any(Array),
      }),
      onFallbackActivated: expect.any(Function),
    });
    expect(runtimeRegistry.getRuntime("terminal-1")).toEqual(
      expect.objectContaining({ pid: runtime.pid }),
    );
  });

  it("attaches a missing runtime to an existing tmux-backed session without using plain tmux capture as the websocket snapshot", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "persisted pty history",
        status: "running",
        exitCode: undefined,
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateRuntimeMetadata: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    const ptyService = {
      spawnSession: vi.fn(() => runtime),
    };
    const tmuxService = {
      withSessionLock: vi.fn(
        async (_id: string, action: () => Promise<unknown>) => action(),
      ),
      hasSession: vi.fn(async () => true),
      buildAttachCommand: vi.fn(() => ({
        command: "tmux",
        args: [
          "-S",
          "/tmp/runweave/tmux.sock",
          "new-session",
          "-A",
          "-s",
          "runweave-terminal-1",
        ],
      })),
      capturePane: vi.fn(async () => ({
        data: "tmux pane history\n",
        durationMs: 10,
      })),
    };

    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
      ptyService as never,
      tmuxService as never,
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
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(ptyService.spawnSession).toHaveBeenCalledWith({
      command: "tmux",
      args: [
        "-S",
        "/tmp/runweave/tmux.sock",
        "new-session",
        "-A",
        "-s",
        "runweave-terminal-1",
      ],
      cwd: "/tmp/demo",
      fallback: null,
      formatQuickExitMessage: expect.any(Function),
    });
    expect(runtimeRegistry.getRuntime("terminal-1")).toEqual(
      expect.objectContaining({ pid: runtime.pid }),
    );
    expect(terminalSessionManager.appendOutput).not.toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          type: "snapshot",
          data: "",
        },
      ]),
    );
    expect(tmuxService.capturePane).not.toHaveBeenCalled();
  });

  it("uses buffered tmux attach output for websocket snapshots", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "plain capture should not be used",
        status: "running",
        exitCode: undefined,
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateRuntimeMetadata: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    runtime.emit("data", "\u001b[?1049h\u001b[Hfresh tmux frame");
    runtimeRegistry.attachClient("terminal-1", "existing-client");
    const tmuxService = {
      capturePane: vi.fn(async () => ({
        data: "plain tmux pane history\n",
        durationMs: 10,
      })),
    };

    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
      undefined,
      tmuxService as never,
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
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(messages).toEqual(
      expect.arrayContaining([
        {
          type: "snapshot",
          data: "\u001b[?1049h\u001b[Hfresh tmux frame",
        },
      ]),
    );
    expect(tmuxService.capturePane).not.toHaveBeenCalled();
  });

  it("publishes tmux pane metadata from pane path and command", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        command: "/bin/zsh",
        args: ["-l"],
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: null,
        scrollback: "",
        status: "running",
        exitCode: undefined,
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      updateSessionMetadata: vi.fn(async () => ({
        id: "terminal-1",
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: "codex",
        scrollback: "",
        status: "running",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    const tmuxService = {
      capturePane: vi.fn(async () => ({
        data: "tmux pane history\n",
        durationMs: 10,
      })),
      readPaneMetadata: vi.fn(async () => ({
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: "codex",
      })),
    };
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry,
      authService as never,
      undefined,
      tmuxService as never,
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

    expect(tmuxService.readPaneMetadata).toHaveBeenCalledWith(
      {
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      },
      "/bin/zsh",
    );
    expect(terminalSessionManager.updateSessionMetadata).toHaveBeenCalledWith(
      "terminal-1",
      {
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: "codex",
      },
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "metadata",
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: "codex",
        }),
      ]),
    );
  });

  it("refreshes tmux pane metadata after terminal input starts a command", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    let currentActiveCommand: string | null = null;
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        command: "/bin/zsh",
        args: ["-l"],
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: currentActiveCommand,
        scrollback: "",
        status: "running",
        exitCode: undefined,
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      updateSessionMetadata: vi.fn(async (_id: string, metadata: { activeCommand: string | null }) => {
        currentActiveCommand = metadata.activeCommand;
        return {
          id: "terminal-1",
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: metadata.activeCommand,
          scrollback: "",
          status: "running",
        };
      }),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    const tmuxService = {
      capturePane: vi.fn(async () => ({
        data: "tmux pane history\n",
        durationMs: 10,
      })),
      readPaneMetadata: vi
        .fn()
        .mockResolvedValueOnce({
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: null,
        })
        .mockResolvedValue({
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: "codex",
        }),
    };
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry,
      authService as never,
      undefined,
      tmuxService as never,
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
    socket.send(JSON.stringify({ type: "input", data: "codex\r" }));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(runtime.write).toHaveBeenCalledWith("codex\r");
    expect(tmuxService.readPaneMetadata).toHaveBeenCalledTimes(2);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "metadata",
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: "codex",
        }),
      ]),
    );
  });

  it("prefers shell command markers over tmux pane_current_command while tmux command is active", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    let currentActiveCommand: string | null = null;
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        command: "/bin/zsh",
        args: ["-l"],
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: currentActiveCommand,
        scrollback: "",
        status: "running",
        exitCode: undefined,
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      updateSessionMetadata: vi.fn(async (_id: string, metadata: { activeCommand: string | null }) => {
        currentActiveCommand = metadata.activeCommand;
        return {
          id: "terminal-1",
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: metadata.activeCommand,
          scrollback: "",
          status: "running",
        };
      }),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    const tmuxService = {
      capturePane: vi.fn(async () => ({
        data: "tmux pane history\n",
        durationMs: 10,
      })),
      readPaneMetadata: vi
        .fn()
        .mockResolvedValueOnce({
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: null,
        })
        .mockResolvedValue({
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: "sleep",
        }),
    };
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry,
      authService as never,
      undefined,
      tmuxService as never,
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
    runtime.emit("data", "\u001b]633;BrowserViewerCommand=codex\u0007");
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(tmuxService.readPaneMetadata).toHaveBeenCalledTimes(1);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "metadata",
          cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
          activeCommand: "codex",
        }),
      ]),
    );
    expect(messages).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          type: "metadata",
          activeCommand: "sleep",
        }),
      ]),
    );
  });

  it("coalesces tmux repaint chunks before the initial websocket snapshot", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
      ),
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "plain capture should not be used",
        status: "running",
        exitCode: undefined,
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateRuntimeMetadata: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    runtime.emit("data", "\u001b[?1049h\u001b[Hpartial frame");
    runtimeRegistry.attachClient("terminal-1", "existing-client");
    const tmuxService = {
      capturePane: vi.fn(async () => ({
        data: "plain tmux pane history\n",
        durationMs: 10,
      })),
    };

    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry as never,
      authService as never,
      undefined,
      tmuxService as never,
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
    setTimeout(() => runtime.emit("data", " after repaint settle"), 10);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(messages).toEqual(
      expect.arrayContaining([
        {
          type: "snapshot",
          data: "\u001b[?1049h\u001b[Hpartial frame after repaint settle",
        },
      ]),
    );
    expect(
      messages.some(
        (message) =>
          message.type === "output" &&
          message.data === " after repaint settle",
      ),
    ).toBe(false);
    expect(tmuxService.capturePane).not.toHaveBeenCalled();
  });

  it("recycles idle tmux attach runtimes so reconnecting clients get a fresh tmux repaint", async () => {
    const staleRuntime = new FakeRuntime();
    const freshRuntime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateRuntimeMetadata: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", staleRuntime);
    const ptyService = {
      spawnSession: vi.fn(() => freshRuntime),
    };
    const tmuxService = {
      withSessionLock: vi.fn(
        async (_id: string, action: () => Promise<unknown>) => action(),
      ),
      hasSession: vi.fn(async () => true),
      buildAttachCommand: vi.fn(() => ({
        command: "tmux",
        args: ["new-session", "-A", "-s", "runweave-terminal-1"],
      })),
      capturePane: vi.fn(async () => ({ data: "plain history", durationMs: 1 })),
    };

    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry,
      authService as never,
      ptyService as never,
      tmuxService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);

    await waitForOpen(socket);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(staleRuntime.dispose).toHaveBeenCalledTimes(1);
    expect(ptyService.spawnSession).toHaveBeenCalledWith({
      command: "tmux",
      args: ["new-session", "-A", "-s", "runweave-terminal-1"],
      cwd: "/tmp/demo",
      fallback: null,
      formatQuickExitMessage: expect.any(Function),
    });
    expect(runtimeRegistry.getRuntime("terminal-1")).toEqual(
      expect.objectContaining({ pid: freshRuntime.pid }),
    );
    expect(tmuxService.capturePane).not.toHaveBeenCalled();
  });

  it("queues resize messages that arrive while tmux runtime recreation is still pending", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateRuntimeMetadata: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    const ptyService = {
      spawnSession: vi.fn(() => runtime),
    };
    let releaseRuntimeRecreation: () => void = () => undefined;
    const runtimeRecreationBlocked = new Promise<void>((resolve) => {
      releaseRuntimeRecreation = resolve;
    });
    const tmuxService = {
      withSessionLock: vi.fn(
        async (_id: string, action: () => Promise<unknown>) => {
          await runtimeRecreationBlocked;
          return action();
        },
      ),
      hasSession: vi.fn(async () => true),
      buildAttachCommand: vi.fn(() => ({
        command: "tmux",
        args: ["new-session", "-A", "-s", "runweave-terminal-1"],
      })),
      capturePane: vi.fn(async () => ({ data: "", durationMs: 1 })),
    };

    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry,
      authService as never,
      ptyService as never,
      tmuxService as never,
    );
    const port = await startServer(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=terminal-1&token=valid-token`,
    );
    sockets.push(socket);

    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "resize", cols: 180, rows: 50 }));
    expect(runtime.resize).not.toHaveBeenCalled();

    releaseRuntimeRecreation();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(runtime.resize).toHaveBeenCalledWith(180, 50);
  });

  it("rebuilds a missing tmux session and warns the websocket client", async () => {
    const runtime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateRuntimeMetadata: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    const ptyService = {
      spawnSession: vi.fn(() => runtime),
    };
    const tmuxService = {
      withSessionLock: vi.fn(
        async (_id: string, action: () => Promise<unknown>) => action(),
      ),
      hasSession: vi.fn(async () => false),
      recordRebuildAttempt: vi.fn(() => ({
        allowed: true,
        count: 1,
        windowMs: 60_000,
        maxAttempts: 3,
      })),
      createDetachedSession: vi.fn(async () => undefined),
      waitForPaneReady: vi.fn(async () => undefined),
      buildAttachCommand: vi.fn(() => ({
        command: "tmux",
        args: ["new-session", "-A", "-s", "runweave-terminal-1"],
      })),
      capturePane: vi.fn(async () => ({ data: "", durationMs: 1 })),
    };
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry,
      authService as never,
      ptyService as never,
      tmuxService as never,
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
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(tmuxService.recordRebuildAttempt).toHaveBeenCalledWith("terminal-1");
    expect(ptyService.spawnSession).toHaveBeenCalledWith({
      command: "tmux",
      args: ["new-session", "-A", "-s", "runweave-terminal-1"],
      cwd: "/tmp/demo",
      fallback: null,
      formatQuickExitMessage: expect.any(Function),
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining("Original tmux session was lost"),
        }),
      ]),
    );
  });

  it("keeps tmux-backed sessions running when the attach client exits", async () => {
    const runtime = new FakeRuntime();
    const replacementRuntime = new FakeRuntime();
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      })),
      markActivity: vi.fn(),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
      updateRuntimeMetadata: vi.fn(),
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime("terminal-1", runtime);
    runtimeRegistry.attachClient("terminal-1", "existing-client");
    const ptyService = {
      spawnSession: vi.fn(() => replacementRuntime),
    };
    const tmuxService = {
      withSessionLock: vi.fn(
        async (_id: string, action: () => Promise<unknown>) => action(),
      ),
      hasSession: vi.fn(async () => true),
      buildAttachCommand: vi.fn(() => ({
        command: "tmux",
        args: ["new-session", "-A", "-s", "runweave-terminal-1"],
      })),
      capturePane: vi.fn(async () => ({ data: "", durationMs: 1 })),
    };
    const server = http.createServer();
    servers.push(server);
    attachTerminalWebSocketServer(
      server,
      terminalSessionManager as never,
      runtimeRegistry,
      authService as never,
      ptyService as never,
      tmuxService as never,
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
    runtime.emit("exit", { exitCode: 0 });
    await waitForClose(socket);

    expect(terminalSessionManager.markExited).not.toHaveBeenCalled();
    expect(ptyService.spawnSession).toHaveBeenCalledWith({
      command: "tmux",
      args: ["new-session", "-A", "-s", "runweave-terminal-1"],
      cwd: "/tmp/demo",
      fallback: null,
      formatQuickExitMessage: expect.any(Function),
    });
    expect(runtimeRegistry.getRuntime("terminal-1")).toEqual(
      expect.objectContaining({ pid: replacementRuntime.pid }),
    );
    expect(messages).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining("reattaching"),
        }),
      ]),
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "status",
          status: "running",
        }),
      ]),
    );
  });

  it("isolates PTY runtime errors triggered by websocket input", async () => {
    const runtime = new FakeRuntime();
    runtime.write.mockImplementation(() => {
      throw new Error("write failed");
    });
    const authService = {
      verifyTemporaryToken: vi.fn(
        (
          _token: string,
          params: { resource: { terminalSessionId?: string } },
        ) => createTerminalTicketVerification(params.resource),
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
