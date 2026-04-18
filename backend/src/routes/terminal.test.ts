import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { promisify } from "node:util";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT,
  TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES,
  TERMINAL_CLIPBOARD_IMAGE_MAX_MIB,
} from "../terminal/clipboard-image";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@browser-viewer/shared";
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
  path: string | null;
  createdAt: Date;
  isDefault: boolean;
}

const execFileAsync = promisify(execFile);

function createTestServer(sessionState: {
  current: MockTerminalSession | null;
  sessions?: MockTerminalSession[];
  projects?: MockTerminalProject[];
}) {
  const resolveSession = (id: string) =>
    sessionState.current?.id === id
      ? sessionState.current
      : sessionState.sessions?.find((session) => session.id === id);
  const projects = sessionState.projects ?? [
    {
      id: "project-default",
      name: "Default Project",
      path: null,
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
        path: null,
        createdAt: new Date("2026-03-29T01:00:00.000Z"),
        isDefault: false,
      };
      projects.push(created);
      return created;
    }),
    updateProject: vi.fn(async (id: string, patch: { name: string; path?: string | null }) => {
      const current = projects.find((project) => project.id === id);
      if (!current) {
        return undefined;
      }
      current.name = patch.name;
      if ("path" in patch) {
        current.path = patch.path ?? null;
      }
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
    getSession: vi.fn((id: string) => resolveSession(id)),
    getProject: vi.fn((id: string) => projects.find((project) => project.id === id)),
    readScrollback: vi.fn(async (id: string) => {
      return resolveSession(id)?.scrollback ?? "";
    }),
    readLiveScrollback: vi.fn(async (id: string) => {
      const session = resolveSession(id);
      if (!session) {
        return "";
      }
      const lines = session.scrollback.split("\n");
      if (lines.length <= TERMINAL_CLIENT_SCROLLBACK_LINES) {
        return session.scrollback;
      }
      return lines.slice(-TERMINAL_CLIENT_SCROLLBACK_LINES).join("\n");
    }),
    getLiveScrollback: vi.fn((id: string) => {
      const session = resolveSession(id);
      if (!session) {
        return "";
      }
      const lines = session.scrollback.split("\n");
      if (lines.length <= TERMINAL_CLIENT_SCROLLBACK_LINES) {
        return session.scrollback;
      }
      return lines.slice(-TERMINAL_CLIENT_SCROLLBACK_LINES).join("\n");
    }),
    listSessions: vi.fn(
      () =>
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
    verifyAccessToken: vi.fn(() => ({
      sessionId: "auth-session-1",
      username: "admin",
    })),
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

async function createGitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-repo-"));
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  await execFileAsync("git", ["config", "user.name", "Terminal Preview Test"], {
    cwd: repo,
  });
  tempDirsForGit.push(repo);
  return repo;
}

const tempDirsForGit: string[] = [];

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
    await Promise.all(
      tempDirsForGit.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    servers.length = 0;
    tempDirs.length = 0;
    tempDirsForGit.length = 0;
  });

  it("creates terminal sessions through the API", async () => {
    const state = { current: null as MockTerminalSession | null };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "project-default",
          command: "bash",
          args: ["-l"],
          cwd: "/tmp/demo",
        }),
      },
    );

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

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "bash",
          linkedBrowserSessionId: "session-1",
        }),
      },
    );

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

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    process.env.SHELL = originalShell;
    expect(response.status).toBe(201);
    expect(terminalSessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/bin/zsh",
        args: ["-l"],
        cwd: os.homedir(),
      }),
    );
  });

  it("defaults zsh sessions to login shell args when args are omitted", async () => {
    const state = { current: null as MockTerminalSession | null };
    const { server, terminalSessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "/bin/zsh",
          cwd: "/tmp/demo",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(terminalSessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/bin/zsh",
        args: ["-l"],
        cwd: "/tmp/demo",
      }),
    );
  });

  it("preserves explicit terminal args when provided", async () => {
    const state = { current: null as MockTerminalSession | null };
    const { server, terminalSessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "/bin/zsh",
          args: ["-i"],
          cwd: "/tmp/demo",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(terminalSessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/bin/zsh",
        args: ["-i"],
        cwd: "/tmp/demo",
      }),
    );
  });

  it("inherits cwd from a referenced terminal session when cwd is omitted", async () => {
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "feat",
        command: "bash",
        args: ["-l"],
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server, terminalSessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inheritFromTerminalSessionId: "terminal-1",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(terminalSessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
      }),
    );
  });

  it("prefers explicit cwd over inherited cwd when both are provided", async () => {
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "feat",
        command: "bash",
        args: ["-l"],
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server, terminalSessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: "/tmp/override",
          inheritFromTerminalSessionId: "terminal-1",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(terminalSessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/override",
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

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
    );

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

  it("reads terminal session history through a dedicated API", async () => {
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "bash",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "bash$ ls\nREADME.md\n",
        status: "exited" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
        exitCode: 0,
      },
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/history`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      terminalSessionId: "terminal-1",
      projectId: "project-default",
      name: "bash",
      command: "bash",
      args: ["-l"],
      cwd: "/tmp/demo",
      scrollback: "bash$ ls\nREADME.md\n",
      status: "exited",
      createdAt: "2026-03-29T00:00:00.000Z",
      exitCode: 0,
    });
  });

  it("limits live terminal scrollback to the configured latest lines", async () => {
    const scrollback = Array.from(
      { length: 2_500 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "bash",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback,
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        terminalSessionId: "terminal-1",
        scrollback: Array.from(
          { length: TERMINAL_CLIENT_SCROLLBACK_LINES },
          (_, index) =>
            `line-${index + (2_500 - TERMINAL_CLIENT_SCROLLBACK_LINES + 1)}`,
        ).join("\n"),
      }),
    );
  });

  it("returns 404 when reading history for an unknown terminal session", async () => {
    const state = { current: null as MockTerminalSession | null };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/missing/history`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      message: "Terminal session not found",
    });
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
    expect(runtimeRegistry.disposeRuntime).toHaveBeenNthCalledWith(
      1,
      "terminal-1",
    );
    expect(runtimeRegistry.disposeRuntime).toHaveBeenNthCalledWith(
      2,
      "terminal-2",
    );
  });

  it("lists and creates terminal projects through the API", async () => {
    const state = {
      current: null as MockTerminalSession | null,
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const listResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project`,
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([
      {
        projectId: "project-default",
        name: "Default Project",
        path: null,
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
      path: null,
      createdAt: "2026-03-29T01:00:00.000Z",
      isDefault: false,
    });
  });

  it("stores a validated project path and uses it as the default terminal cwd", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-project-"));
    tempDirs.push(projectPath);
    const state = {
      current: null as MockTerminalSession | null,
    };
    const { server, terminalSessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);
    const normalizedProjectPath = await realpath(projectPath);

    const updateResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Default Project",
          path: projectPath,
        }),
      },
    );

    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual(
      expect.objectContaining({
        projectId: "project-default",
        path: normalizedProjectPath,
      }),
    );

    const createResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "project-default" }),
      },
    );

    expect(createResponse.status).toBe(201);
    expect(terminalSessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: normalizedProjectPath,
      }),
    );
  });

  it("rejects project paths that are not directories", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-project-"));
    const filePath = path.join(projectPath, "README.md");
    tempDirs.push(projectPath);
    await writeFile(filePath, "# demo\n");
    const state = {
      current: null as MockTerminalSession | null,
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Default Project",
          path: filePath,
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      message: "Project path must be a readable directory",
    });
  });

  it("previews a project file directly from the project route", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-"));
    tempDirs.push(projectPath);
    await writeFile(path.join(projectPath, "README.md"), "# Project Preview\n");
    const state = {
      current: null,
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: projectPath,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file?path=README.md`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        kind: "file",
        projectId: "project-default",
        path: "README.md",
        projectPath,
        language: "markdown",
        content: "# Project Preview\n",
        readonly: true,
      }),
    );
  });

  it("serves project preview image assets with no-store caching", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-"));
    tempDirs.push(projectPath);
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(path.join(projectPath, "preview.png"), imageBytes);
    const state = {
      current: null,
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: projectPath,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/asset?path=preview.png`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(imageBytes)).toBe(true);
  });

  it("does not expose legacy session-scoped preview routes", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-"));
    tempDirs.push(projectPath);
    await writeFile(path.join(projectPath, "README.md"), "# Preview\n");
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "bash",
        command: "bash",
        args: [],
        cwd: projectPath,
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: projectPath,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/preview/file?path=README.md`,
    );

    expect(response.status).toBe(404);
  });

  it("rejects project preview paths outside the project path", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "terminal-outside-"));
    tempDirs.push(projectPath, outsideDir);
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret\n");
    const state = {
      current: null,
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: projectPath,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file?path=${encodeURIComponent(outsideFile)}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: "Path is outside the project path",
    });
  });

  it("rejects project preview files that symlink outside the project path", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "terminal-outside-"));
    tempDirs.push(projectPath, outsideDir);
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret\n");
    await symlink(outsideFile, path.join(projectPath, "linked-secret.txt"));
    const state = {
      current: null,
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: projectPath,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file?path=linked-secret.txt`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: "Path is outside the project path",
    });
  });

  it("searches project preview files by fuzzy relative path without returning absolute candidates", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-"));
    tempDirs.push(projectPath);
    await mkdir(path.join(projectPath, "frontend/src/components/terminal"), {
      recursive: true,
    });
    await mkdir(path.join(projectPath, "docs/architecture"), { recursive: true });
    await writeFile(
      path.join(projectPath, "frontend/src/components/terminal/terminal-workspace.tsx"),
      "export {}\n",
    );
    await writeFile(
      path.join(projectPath, "docs/architecture/terminal-code-preview.md"),
      "# plan\n",
    );
    const state = {
      current: null,
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: projectPath,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/files/search?q=term%20work&limit=10`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      items: Array<{ path: string; basename: string; dirname: string }>;
    };
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        path: "frontend/src/components/terminal/terminal-workspace.tsx",
        basename: "terminal-workspace.tsx",
        dirname: "frontend/src/components/terminal",
      }),
    );
    expect(payload.items.every((item) => !path.isAbsolute(item.path))).toBe(true);
  });

  it("searches project preview files without returning gitignored files", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "terminal-preview-"));
    tempDirs.push(projectPath);
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    await mkdir(path.join(projectPath, "generated"), { recursive: true });
    await writeFile(path.join(projectPath, ".gitignore"), "generated/\n");
    await writeFile(path.join(projectPath, "src/terminal-preview.ts"), "export {};\n");
    await writeFile(path.join(projectPath, "generated/terminal-preview.js"), "ignored\n");
    const state = {
      current: null,
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: projectPath,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/files/search?q=terminal%20preview&limit=20`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      items: Array<{ path: string }>;
    };
    expect(payload.items.map((item) => item.path)).toContain(
      "src/terminal-preview.ts",
    );
    expect(payload.items.map((item) => item.path)).not.toContain(
      "generated/terminal-preview.js",
    );
  });

  it("returns project preview changes and file diffs directly from the project route", async () => {
    const repo = await createGitRepo();
    await writeFile(path.join(repo, "README.md"), "old readme\n");
    await writeFile(path.join(repo, "staged.txt"), "old staged\n");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
    await writeFile(path.join(repo, "staged.txt"), "new staged\n");
    await execFileAsync("git", ["add", "staged.txt"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "new readme\n");
    const state = {
      current: null,
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: repo,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const changesResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/git-changes`,
    );

    expect(changesResponse.status).toBe(200);
    await expect(changesResponse.json()).resolves.toEqual(
      expect.objectContaining({
        staged: [{ path: "staged.txt", status: "modified" }],
        working: [{ path: "README.md", status: "modified" }],
      }),
    );

    const diffResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file-diff?path=staged.txt&kind=staged`,
    );

    expect(diffResponse.status).toBe(200);
    await expect(diffResponse.json()).resolves.toEqual(
      expect.objectContaining({
        kind: "file-diff",
        changeKind: "staged",
        path: "staged.txt",
        status: "modified",
        oldContent: "old staged\n",
        newContent: "new staged\n",
        readonly: true,
      }),
    );
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
          path: null,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
        {
          id: "project-2",
          name: "browser-viewer",
          path: null,
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
        headers: { Authorization: "Bearer access-token-1" },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ticket: "terminal-ticket-123",
      expiresIn: 60,
    });
    expect(authService.issueTemporaryToken).toHaveBeenCalledWith({
      sessionId: "auth-session-1",
      tokenType: "terminal-ws",
      resource: { terminalSessionId: "terminal-1" },
      ttlMs: 60_000,
    });
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
      path.join(
        os.tmpdir(),
        "browser-viewer-terminal-images",
        payload.fileName,
      ),
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
