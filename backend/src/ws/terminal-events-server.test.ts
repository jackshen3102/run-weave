import http from "node:http";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { AuthService } from "../auth/service";
import { TerminalEventService } from "../terminal/terminal-event-service";
import { attachTerminalEventsWebSocketServer } from "./terminal-events-server";

async function startServer(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
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

function createAuthService(): AuthService {
  return new AuthService({
    username: "admin",
    password: "secret",
    jwtSecret: "test-secret",
    accessTokenTtlMs: 60_000,
    refreshTokenTtlMs: 60_000,
    refreshCookieName: "refresh",
    secureCookies: false,
  });
}

function waitForMessage<T>(socket: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("message", onMessage);
    };
    const onMessage = (data: WebSocket.RawData): void => {
      cleanup();
      resolve(JSON.parse(String(data)) as T);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      reject(
        new Error(`Socket closed before message: ${code} ${String(reason)}`),
      );
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function waitForClose(
  socket: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: String(reason) });
    });
  });
}

describe("terminal events websocket server", () => {
  it("sends catch-up events and pushes live completion events", async () => {
    const authService = createAuthService();
    const login = await authService.login("admin", "secret");
    expect(login).not.toBeNull();
    const terminalEventService = new TerminalEventService();
    const session = {
      id: "terminal-1",
      projectId: "project-1",
      command: "bash",
      args: [],
      cwd: "/tmp/demo",
      activeCommand: "codex",
      scrollback: "",
      status: "running" as const,
      createdAt: new Date("2026-06-07T00:00:00.000Z"),
      lastActivityAt: new Date("2026-06-07T00:00:00.000Z"),
      runtimeKind: "tmux" as const,
    };
    terminalEventService.record({
      kind: "completion",
      terminalSessionId: session.id,
      projectId: session.projectId,
      payload: {
        source: "codex",
        completionReason: "hook_stop",
        commandName: "codex",
        rawHookEvent: "Stop",
        hookEvent: "Stop",
        cwd: session.cwd,
      },
    });
    const server = http.createServer();
    attachTerminalEventsWebSocketServer(
      server,
      authService,
      terminalEventService,
    );

    try {
      const port = await startServer(server);
      const ticket = authService.issueTemporaryToken({
        sessionId: login!.sessionId,
        tokenType: "terminal-events-ws",
        resource: {},
        ttlMs: 60_000,
      });
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws/terminal-events?token=${encodeURIComponent(ticket.token)}&after=`,
      );
      const messages: unknown[] = [];
      socket.on("message", (data) => {
        messages.push(JSON.parse(String(data)) as unknown);
      });

      await expect.poll(() => messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0]).toMatchObject({
        type: "connected",
        acceptedAfter: null,
      });
      expect(messages[1]).toMatchObject({
        type: "terminal-events",
        delivery: "catchup",
        events: [
          { id: "1", kind: "completion", terminalSessionId: session.id },
        ],
      });

      const liveStartIndex = messages.length;
      terminalEventService.record({
        kind: "terminal_state_changed",
        terminalSessionId: "terminal-2",
        projectId: "project-1",
        payload: {
          previous: { state: "agent_idle", agent: "codex" },
          next: { state: "agent_running", agent: "codex" },
          reason: "agent_hook",
        },
      });
      await expect.poll(() => messages.length).toBeGreaterThan(liveStartIndex);
      expect(messages[liveStartIndex]).toMatchObject({
        type: "terminal-event",
        delivery: "live",
        event: {
          id: "2",
          kind: "terminal_state_changed",
          terminalSessionId: "terminal-2",
        },
      });

      socket.close();
    } finally {
      await stopServer(server);
    }
  });

  it("rejects missing after cursors", async () => {
    const authService = createAuthService();
    const login = await authService.login("admin", "secret");
    expect(login).not.toBeNull();
    const server = http.createServer();
    attachTerminalEventsWebSocketServer(
      server,
      authService,
      new TerminalEventService(),
    );

    try {
      const port = await startServer(server);
      const ticket = authService.issueTemporaryToken({
        sessionId: login!.sessionId,
        tokenType: "terminal-events-ws",
        resource: {},
        ttlMs: 60_000,
      });
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws/terminal-events?token=${encodeURIComponent(ticket.token)}`,
      );

      await expect(waitForMessage(socket)).resolves.toMatchObject({
        type: "error",
        message: "Missing after",
      });
      await expect(waitForClose(socket)).resolves.toMatchObject({
        code: 1008,
        reason: "Missing after",
      });
    } finally {
      await stopServer(server);
    }
  });
});
