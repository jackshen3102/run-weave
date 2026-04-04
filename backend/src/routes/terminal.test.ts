import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT,
  TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES,
  TERMINAL_CLIPBOARD_IMAGE_MAX_MIB,
} from "../terminal/clipboard-image";
import { createTerminalRouter } from "./terminal";

interface MockTerminalSession {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  scrollback: string;
  status: "running" | "exited";
  createdAt: Date;
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
      }) => {
        const created: MockTerminalSession = {
          id: "terminal-1",
          name: options.name ?? options.command,
          command: options.command,
          args: options.args ?? [],
          cwd: options.cwd,
          scrollback: "",
          status: "running",
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
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
  const authService = {
    issueTemporaryToken: vi.fn(() => ({
      token: "terminal-ticket-123",
      expiresIn: 60,
    })),
  };
  app.use(express.json({ limit: TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT }));
  app.use(
    "/api/terminal",
    createTerminalRouter(terminalSessionManager as never, {
      authService: authService as never,
    }),
  );
  const server = http.createServer(app);

  return { server, terminalSessionManager, authService };
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
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => stopServer(server)));
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    servers.length = 0;
    tempDirs.length = 0;
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
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      terminalSessionId: "terminal-1",
      terminalUrl: "/terminal/terminal-1",
    });
  });

  it("rejects removed browser-link terminal field", async () => {
    const state = { current: null as MockTerminalSession | null };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "bash",
        linkedBrowserSessionId: "session-1",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        message: "Invalid request body",
      }),
    );
  });

  it("uses default shell and user home when command/cwd are omitted", async () => {
    const state = { current: null as MockTerminalSession | null };
    const { server, terminalSessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";

    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    process.env.SHELL = originalShell;
    expect(response.status).toBe(201);
    expect(terminalSessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/bin/zsh",
        cwd: os.homedir(),
      }),
    );
  });

  it("lists terminal sessions through the API", async () => {
    const state = {
      current: {
        id: "terminal-1",
        name: "bash",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "bash$ ",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
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
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
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

  it("issues a short-lived terminal websocket ticket", async () => {
    const state = {
      current: {
        id: "terminal-1",
        name: "bash",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server, authService } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/ws-ticket`,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ticket: "terminal-ticket-123",
      expiresIn: 60,
    });
    expect(authService.issueTemporaryToken).toHaveBeenCalledWith(
      "terminal",
      60_000,
    );
  });

  it("stores uploaded clipboard images in the system temp directory", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "terminal-upload-"));
    tempDirs.push(cwd);
    const state = {
      current: {
        id: "terminal-1",
        name: "bash",
        command: "bash",
        args: [],
        cwd,
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/clipboard-image`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mimeType: "image/png",
          dataBase64: "AQIDBA==",
        }),
      },
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      fileName: string;
      filePath: string;
    };
    expect(payload.fileName).toMatch(
      /^browser-viewer-terminal-image-\d{8}-\d{6}-[a-f0-9]{6}\.png$/,
    );
    expect(payload.filePath).toBe(
      path.join(os.tmpdir(), "browser-viewer-terminal-images", payload.fileName),
    );
    await expect(readFile(payload.filePath)).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it("rejects clipboard images larger than 100 MiB after base64 decoding", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "terminal-upload-"));
    tempDirs.push(cwd);
    const state = {
      current: {
        id: "terminal-1",
        name: "bash",
        command: "bash",
        args: [],
        cwd,
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const oversizedPayload = Buffer.alloc(
      TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES + 1,
      1,
    ).toString("base64");
    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/clipboard-image`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mimeType: "image/png",
          dataBase64: oversizedPayload,
        }),
      },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      message: `Clipboard image exceeds ${TERMINAL_CLIPBOARD_IMAGE_MAX_MIB} MiB limit`,
    });
  });
});
