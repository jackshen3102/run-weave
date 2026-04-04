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
  projectId?: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  scrollback: string;
  status: "running" | "exited";
  createdAt: Date;
  exitCode?: number;
}

interface MockTerminalProject {
  id: string;
  name: string;
  createdAt: Date;
  isDefault: boolean;
}

function createTestServer(sessionState: {
  current: MockTerminalSession | null;
  sessions?: MockTerminalSession[];
  projects?: MockTerminalProject[];
}) {
  const projects =
    sessionState.projects ??
    [
      {
        id: "project-default",
        name: "Default Project",
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
        isDefault: true,
      },
    ];
  const terminalSessionManager = {
    createSession: vi.fn(
      async (options: {
        projectId?: string;
        name?: string;
        command: string;
        args?: string[];
        cwd: string;
      }) => {
        const created: MockTerminalSession = {
          id: "terminal-1",
          projectId: options.projectId ?? projects[0]?.id ?? "project-default",
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
    listProjects: vi.fn(() => projects),
    createProject: vi.fn(async (name: string) => {
      const created = {
        id: "project-2",
        name,
        createdAt: new Date("2026-03-29T01:00:00.000Z"),
        isDefault: false,
      };
      projects.push(created);
      return created;
    }),
    updateProject: vi.fn(async (id: string, patch: { name: string }) => {
      const current = projects.find((project) => project.id === id);
      if (!current) {
        return undefined;
      }
      current.name = patch.name;
      return current;
    }),
    deleteProject: vi.fn(async (id: string) => {
      const index = projects.findIndex((project) => project.id === id);
      if (index < 0) {
        return false;
      }
      projects.splice(index, 1);
      if (sessionState.current?.projectId === id) {
        sessionState.current = null;
      }
      return true;
    }),
    getSession: vi.fn((id: string) =>
      sessionState.current?.id === id ? sessionState.current : undefined,
    ),
    listSessions: vi.fn(() =>
      sessionState.sessions ??
      (sessionState.current ? [sessionState.current] : []),
    ),
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
  const runtimeRegistry = {
    disposeRuntime: vi.fn(async () => undefined),
  };
  app.use(express.json({ limit: TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT }));
  app.use(
    "/api/terminal",
    createTerminalRouter(terminalSessionManager as never, {
      authService: authService as never,
      runtimeRegistry: runtimeRegistry as never,
    }),
  );
  const server = http.createServer(app);

  return { server, terminalSessionManager, authService, runtimeRegistry };
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
        projectId: "project-default",
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
        projectId: "project-default",
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
        projectId: "project-default",
        name: "bash",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        status: "running",
        createdAt: "2026-03-29T00:00:00.000Z",
      },
    ]);
  });

  it("disposes project runtimes before cascading terminal deletion", async () => {
    const state = {
      current: null as MockTerminalSession | null,
      sessions: [
        {
          id: "terminal-1",
          projectId: "project-default",
          name: "shell-1",
          command: "bash",
          args: [],
          cwd: "/tmp/a",
          scrollback: "",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
        },
        {
          id: "terminal-2",
          projectId: "project-default",
          name: "shell-2",
          command: "bash",
          args: [],
          cwd: "/tmp/b",
          scrollback: "",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:01:00.000Z"),
        },
        {
          id: "terminal-3",
          projectId: "project-2",
          name: "other",
          command: "bash",
          args: [],
          cwd: "/tmp/c",
          scrollback: "",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:02:00.000Z"),
        },
      ],
    };
    const { server, runtimeRegistry } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(204);
    expect(runtimeRegistry.disposeRuntime).toHaveBeenCalledTimes(2);
    expect(runtimeRegistry.disposeRuntime).toHaveBeenNthCalledWith(1, "terminal-1");
    expect(runtimeRegistry.disposeRuntime).toHaveBeenNthCalledWith(2, "terminal-2");
  });

  it("lists and creates terminal projects through the API", async () => {
    const state = {
      current: null as MockTerminalSession | null,
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/terminal/project`);

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([
      {
        projectId: "project-default",
        name: "Default Project",
        createdAt: "2026-03-29T00:00:00.000Z",
        isDefault: true,
      },
    ]);

    const createResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "browser-viewer" }),
      },
    );

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toEqual({
      projectId: "project-2",
      name: "browser-viewer",
      createdAt: "2026-03-29T01:00:00.000Z",
      isDefault: false,
    });
  });

  it("deletes terminal projects through the API and cascades child sessions", async () => {
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-2",
        name: "bash",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
        {
          id: "project-2",
          name: "browser-viewer",
          createdAt: new Date("2026-03-29T01:00:00.000Z"),
          isDefault: false,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-2`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(204);
    expect(state.current).toBeNull();
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
