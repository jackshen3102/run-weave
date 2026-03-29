import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalRouter } from "./terminal";

interface MockTerminalSession {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  linkedBrowserSessionId?: string;
  status: "running" | "exited";
  createdAt: Date;
  lastActivityAt: Date;
  exitCode?: number;
}

function createTestServer(sessionState: { current: MockTerminalSession | null }) {
  const terminalSessionManager = {
    createSession: vi.fn(
      async (options: {
        name?: string;
        command: string;
        args?: string[];
        cwd: string;
        linkedBrowserSessionId?: string;
      }) => {
        const created: MockTerminalSession = {
          id: "terminal-1",
          name: options.name ?? options.command,
          command: options.command,
          args: options.args ?? [],
          cwd: options.cwd,
          linkedBrowserSessionId: options.linkedBrowserSessionId,
          status: "running",
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          lastActivityAt: new Date("2026-03-29T00:00:00.000Z"),
        };
        sessionState.current = created;
        return created;
      },
    ),
    getSession: vi.fn((id: string) =>
      sessionState.current?.id === id ? sessionState.current : undefined,
    ),
    listSessions: vi.fn(() => (sessionState.current ? [sessionState.current] : [])),
    destroySession: vi.fn(async (id: string) => {
      if (sessionState.current?.id !== id) {
        return false;
      }
      sessionState.current = null;
      return true;
    }),
    updateSessionName: vi.fn(async (id: string, name: string) => {
      if (sessionState.current?.id !== id) {
        return undefined;
      }
      sessionState.current = {
        ...sessionState.current,
        name,
      };
      return sessionState.current;
    }),
  };

  const app = express();
  app.use(express.json());
  app.use("/api/terminal", createTerminalRouter(terminalSessionManager as never));
  const server = http.createServer(app);

  return { server, terminalSessionManager };
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

describe("terminal routes", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("creates terminal sessions through the API", async () => {
    const state = { current: null as MockTerminalSession | null };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        linkedBrowserSessionId: "session-1",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      terminalSessionId: "terminal-1",
      terminalUrl: "/terminal/terminal-1",
    });
  });

  it("lists terminal sessions through the API", async () => {
    const state = {
      current: {
        id: "terminal-1",
        name: "bash",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
        lastActivityAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/session`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        terminalSessionId: "terminal-1",
        name: "bash",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        status: "running",
        createdAt: "2026-03-29T00:00:00.000Z",
        lastActivityAt: "2026-03-29T00:00:00.000Z",
      },
    ]);
  });

  it("deletes terminal sessions through the API", async () => {
    const state = {
      current: {
        id: "terminal-1",
        name: "bash",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
        lastActivityAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(204);
  });
});
