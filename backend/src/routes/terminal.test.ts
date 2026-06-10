import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
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
import { createAppHomeOverviewRouter } from "./app-home-overview";
import { createTerminalRouter } from "./terminal";
import { createTerminalStateRouter } from "./terminal-state";
import { TerminalStateService } from "../terminal/terminal-state-service";
import { TerminalStateStore } from "../terminal/terminal-state-store";

interface MockTerminalSession {
  id: string;
  projectId?: string;
  command: string;
  args: string[];
  cwd: string;
  activeCommand?: string | null;
  scrollback: string;
  status: "running" | "exited";
  createdAt: Date;
  lastActivityAt?: Date;
  exitCode?: number;
  runtimeKind?: "pty" | "tmux";
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
  tmuxUnavailableReason?: string;
  recoverable?: boolean;
}

interface MockTerminalProject {
  id: string;
  name: string;
  path: string | null;
  createdAt: Date;
  isDefault: boolean;
}

const execFileAsync = promisify(execFile);

function createTestServer(
  sessionState: {
    current: MockTerminalSession | null;
    sessions?: MockTerminalSession[];
    projects?: MockTerminalProject[];
  },
  options?: {
    ptyService?: unknown;
    runtimeRegistry?: unknown;
    tmuxService?: unknown;
  },
) {
  const resolveRawSession = (id: string) =>
    sessionState.current?.id === id
      ? sessionState.current
      : sessionState.sessions?.find((session) => session.id === id);
  const normalizeSession = (session: MockTerminalSession | undefined | null) =>
    session
      ? {
          ...session,
          activeCommand: session.activeCommand ?? null,
          lastActivityAt: session.lastActivityAt ?? session.createdAt,
        }
      : undefined;
  const resolveSession = (id: string) =>
    normalizeSession(resolveRawSession(id));
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
        command: string;
        args?: string[];
        cwd: string;
      }) => {
        const created: MockTerminalSession = {
          id: "terminal-1",
          projectId: options.projectId ?? projects[0]?.id ?? "project-default",
          command: options.command,
          args: options.args ?? [],
          cwd: options.cwd,
          activeCommand: null,
          scrollback: "",
          status: "running",
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          lastActivityAt: new Date("2026-03-29T00:00:00.000Z"),
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
    updateProject: vi.fn(
      async (id: string, patch: { name: string; path?: string | null }) => {
        const current = projects.find((project) => project.id === id);
        if (!current) {
          return undefined;
        }
        current.name = patch.name;
        if ("path" in patch) {
          current.path = patch.path ?? null;
        }
        return current;
      },
    ),
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
    getProject: vi.fn((id: string) =>
      projects.find((project) => project.id === id),
    ),
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
    listSessions: vi.fn(() =>
      (
        sessionState.sessions ??
        (sessionState.current ? [sessionState.current] : [])
      ).map((session) => normalizeSession(session)),
    ),
    destroySession: vi.fn(async (id: string) => {
      if (sessionState.current?.id !== id) {
        return false;
      }
      sessionState.current = null;
      return true;
    }),
    updateRuntimeMetadata: vi.fn(
      async (id: string, metadata: Partial<MockTerminalSession>) => {
        const session = resolveRawSession(id);
        if (!session) {
          return undefined;
        }
        Object.assign(session, metadata);
        return normalizeSession(session);
      },
    ),
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
    getRuntime: vi.fn(() => undefined),
    createRuntime: vi.fn(),
    ensureRecorder: vi.fn(),
    disposeRuntime: vi.fn(async () => undefined),
  };
  const terminalStateService = new TerminalStateService(
    new TerminalStateStore(),
  );
  app.use(express.json({ limit: TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT }));
  app.use(
    "/api/terminal",
    createTerminalStateRouter({
      terminalSessionManager: terminalSessionManager as never,
      terminalStateService,
    }),
  );
  app.use(
    "/api/app",
    createAppHomeOverviewRouter({
      terminalSessionManager: terminalSessionManager as never,
      terminalStateService,
    }),
  );
  app.use(
    "/api/terminal",
    createTerminalRouter(terminalSessionManager as never, {
      authService: authService as never,
      ptyService: options?.ptyService as never,
      runtimeRegistry: (options?.runtimeRegistry ?? runtimeRegistry) as never,
      tmuxService: options?.tmuxService as never,
    }),
  );
  const server = http.createServer(app);

  return {
    server,
    terminalSessionManager,
    terminalStateService,
    authService,
    runtimeRegistry,
  };
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
    vi.unstubAllEnvs();
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

  it("returns terminal state from current session metadata", async () => {
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: "codex",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/state`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      terminalState: { state: "agent_idle", agent: "codex" },
    });
  });

  it("returns shell idle for non-codex and exited sessions", async () => {
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: "node",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
      sessions: [
        {
          id: "terminal-exited",
          projectId: "project-default",
          command: "bash",
          args: [],
          cwd: "/tmp/demo",
          activeCommand: "codex",
          scrollback: "",
          status: "exited" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
        },
      ],
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    await expect(
      fetch(
        `http://127.0.0.1:${port}/api/terminal/session/terminal-1/state`,
      ).then((response) => response.json()),
    ).resolves.toEqual({
      terminalState: { state: "shell_idle", agent: null },
    });
    await expect(
      fetch(
        `http://127.0.0.1:${port}/api/terminal/session/terminal-exited/state`,
      ).then((response) => response.json()),
    ).resolves.toEqual({
      terminalState: { state: "shell_idle", agent: null },
    });
  });

  it("creates tmux-backed terminal sessions when tmux is available", async () => {
    vi.stubEnv(
      "RUNWEAVE_HOOK_ENDPOINT",
      "http://127.0.0.1:5000/internal/terminal/agent-hook",
    );
    vi.stubEnv(
      "RUNWEAVE_COMPLETION_HOOK_ENDPOINT",
      "http://127.0.0.1:5001/internal/terminal-completion",
    );
    vi.stubEnv("RUNWEAVE_HOOK_TOKEN", "hook-token");
    const state = { current: null as MockTerminalSession | null };
    const runtime = { pid: 10 };
    const ptyService = {
      spawnSession: vi.fn(() => runtime),
    };
    const runtimeRegistry = {
      getRuntime: vi.fn(() => undefined),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const tmuxService = {
      isAvailable: vi.fn(async () => true),
      buildTarget: vi.fn(() => ({
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      })),
      withSessionLock: vi.fn(
        async (_id: string, action: () => Promise<unknown>) => action(),
      ),
      hasSession: vi.fn(async () => false),
      createDetachedSession: vi.fn(async () => undefined),
      waitForPaneReady: vi.fn(async () => undefined),
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
    };
    const { server, terminalSessionManager } = createTestServer(state, {
      ptyService,
      runtimeRegistry,
      tmuxService,
    });
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
    expect(terminalSessionManager.updateRuntimeMetadata).toHaveBeenCalledWith(
      "terminal-1",
      {
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
        recoverable: true,
      },
    );
    expect(tmuxService.createDetachedSession).toHaveBeenCalledWith(
      {
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      },
      "/tmp/demo",
      {
        command: "bash",
        args: ["-l"],
        env: {
          RUNWEAVE_TERMINAL_SESSION_ID: "terminal-1",
          RUNWEAVE_PROJECT_ID: "project-default",
          RUNWEAVE_TMUX_SESSION_NAME: "runweave-terminal-1",
          RUNWEAVE_HOOK_ENDPOINT:
            "http://127.0.0.1:5000/internal/terminal/agent-hook",
          RUNWEAVE_COMPLETION_HOOK_ENDPOINT:
            "http://127.0.0.1:5001/internal/terminal-completion",
          RUNWEAVE_HOOK_TOKEN: "hook-token",
        },
      },
    );
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
    expect(runtimeRegistry.createRuntime).toHaveBeenCalledWith(
      "terminal-1",
      expect.objectContaining({ pid: runtime.pid }),
    );
    expect(runtimeRegistry.ensureRecorder).not.toHaveBeenCalled();
  });

  it("falls back to pty sessions when tmux is unavailable", async () => {
    const state = { current: null as MockTerminalSession | null };
    const runtime = { pid: 10 };
    const ptyService = {
      spawnSession: vi.fn(() => runtime),
    };
    const runtimeRegistry = {
      getRuntime: vi.fn(() => undefined),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const tmuxService = {
      isAvailable: vi.fn(async () => false),
      getUnavailableReason: vi.fn(async () => "tmux missing"),
    };
    const { server, terminalSessionManager } = createTestServer(state, {
      ptyService,
      runtimeRegistry,
      tmuxService,
    });
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
    expect(terminalSessionManager.updateRuntimeMetadata).toHaveBeenCalledWith(
      "terminal-1",
      {
        runtimeKind: "pty",
        tmuxUnavailableReason: "tmux missing",
        recoverable: false,
      },
    );
    expect(ptyService.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        fallback: expect.any(Object),
      }),
    );
    expect(runtimeRegistry.ensureRecorder).toHaveBeenCalled();
  });

  it("falls back to pty sessions when auto tmux launch fails", async () => {
    vi.stubEnv("RUNWEAVE_HOOK_TOKEN", "super-secret-hook-token");
    const state = { current: null as MockTerminalSession | null };
    const runtime = { pid: 10 };
    const ptyService = {
      spawnSession: vi.fn(() => runtime),
    };
    const runtimeRegistry = {
      getRuntime: vi.fn(() => undefined),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const tmuxService = {
      isAvailable: vi.fn(async () => true),
      buildTarget: vi.fn(() => ({
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      })),
      withSessionLock: vi.fn(
        async (_id: string, action: () => Promise<unknown>) => action(),
      ),
      hasSession: vi.fn(async () => false),
      createDetachedSession: vi.fn(async () => {
        throw new Error(
          "Command failed: tmux new-session -e RUNWEAVE_HOOK_TOKEN=super-secret-hook-token\ncreate window failed: fork failed: Device not configured",
        );
      }),
      waitForPaneReady: vi.fn(async () => undefined),
      buildAttachCommand: vi.fn(() => ({
        command: "tmux",
        args: ["new-session", "-A", "-s", "runweave-terminal-1"],
      })),
      killSession: vi.fn(async () => undefined),
    };
    const { server, terminalSessionManager } = createTestServer(state, {
      ptyService,
      runtimeRegistry,
      tmuxService,
    });
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
    expect(
      terminalSessionManager.updateRuntimeMetadata,
    ).toHaveBeenLastCalledWith("terminal-1", {
      runtimeKind: "pty",
      tmuxUnavailableReason: "tmux launch failed; fell back to pty",
      recoverable: false,
    });
    expect(terminalSessionManager.destroySession).not.toHaveBeenCalled();
    expect(tmuxService.killSession).toHaveBeenCalledWith({
      sessionName: "runweave-terminal-1",
      socketPath: "/tmp/runweave/tmux.sock",
    });
    expect(ptyService.spawnSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        fallback: expect.any(Object),
      }),
    );
    expect(runtimeRegistry.ensureRecorder).toHaveBeenCalled();
  });

  it("redacts hook tokens when explicit tmux launch fails", async () => {
    vi.stubEnv("RUNWEAVE_HOOK_TOKEN", "super-secret-hook-token");
    const state = { current: null as MockTerminalSession | null };
    const ptyService = {
      spawnSession: vi.fn(),
    };
    const runtimeRegistry = {
      getRuntime: vi.fn(() => undefined),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const tmuxService = {
      isAvailable: vi.fn(async () => true),
      buildTarget: vi.fn(() => ({
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      })),
      withSessionLock: vi.fn(
        async (_id: string, action: () => Promise<unknown>) => action(),
      ),
      hasSession: vi.fn(async () => false),
      createDetachedSession: vi.fn(async () => {
        throw new Error(
          "Command failed: tmux new-session -e RUNWEAVE_HOOK_TOKEN=super-secret-hook-token",
        );
      }),
      waitForPaneReady: vi.fn(async () => undefined),
      buildAttachCommand: vi.fn(),
    };
    const { server } = createTestServer(state, {
      ptyService,
      runtimeRegistry,
      tmuxService,
    });
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
          runtimePreference: "tmux",
        }),
      },
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("RUNWEAVE_HOOK_TOKEN=[redacted]");
    expect(body.error).not.toContain("super-secret-hook-token");
  });

  it("creates pty terminal sessions when explicitly requested even if tmux is available", async () => {
    const state = { current: null as MockTerminalSession | null };
    const runtime = { pid: 10 };
    const ptyService = {
      spawnSession: vi.fn(() => runtime),
    };
    const runtimeRegistry = {
      getRuntime: vi.fn(() => undefined),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const tmuxService = {
      isAvailable: vi.fn(async () => true),
      buildTarget: vi.fn(),
    };
    const { server, terminalSessionManager } = createTestServer(state, {
      ptyService,
      runtimeRegistry,
      tmuxService,
    });
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
          runtimePreference: "pty",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(tmuxService.isAvailable).not.toHaveBeenCalled();
    expect(tmuxService.buildTarget).not.toHaveBeenCalled();
    expect(terminalSessionManager.updateRuntimeMetadata).not.toHaveBeenCalled();
    expect(ptyService.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        fallback: expect.any(Object),
      }),
    );
    expect(runtimeRegistry.ensureRecorder).toHaveBeenCalled();
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
    const inheritedCwd = await mkdtemp(
      path.join(os.tmpdir(), "terminal-inherit-"),
    );
    tempDirs.push(inheritedCwd);
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "feat",
        command: "bash",
        args: ["-l"],
        cwd: inheritedCwd,
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
        cwd: inheritedCwd,
      }),
    );
  });

  it("falls back to the project path when inherited cwd no longer exists", async () => {
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), "runweave-project-"),
    );
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "stale",
        command: "bash",
        args: ["-l"],
        cwd: path.join(projectDir, "missing_zsh"),
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
      },
      projects: [
        {
          id: "project-default",
          name: "Default Project",
          path: projectDir,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          isDefault: true,
        },
      ],
    };
    const { server, terminalSessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    try {
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
          cwd: projectDir,
        }),
      );
    } finally {
      await rm(projectDir, { force: true, recursive: true });
    }
  });

  it("prefers explicit cwd over inherited cwd when both are provided", async () => {
    const inheritedCwd = await mkdtemp(
      path.join(os.tmpdir(), "terminal-inherit-"),
    );
    tempDirs.push(inheritedCwd);
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "feat",
        command: "bash",
        args: ["-l"],
        cwd: inheritedCwd,
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
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        activeCommand: null,
        status: "running",
        createdAt: "2026-03-29T00:00:00.000Z",
        lastActivityAt: "2026-03-29T00:00:00.000Z",
      },
    ]);
  });

  it("returns app home overview display fields without reading tails", async () => {
    const state = {
      current: null as MockTerminalSession | null,
      sessions: [
        {
          id: "terminal-idle",
          projectId: "project-default",
          command: "bash",
          args: ["-l"],
          cwd: "/tmp/demo",
          activeCommand: null,
          scrollback: "idle tail",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          lastActivityAt: new Date("2026-03-29T00:02:00.000Z"),
        },
        {
          id: "terminal-running",
          projectId: "project-default",
          command: "zsh",
          args: ["-l"],
          cwd: "/tmp/browser-viewer",
          activeCommand: "codex",
          scrollback: "running tail",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          lastActivityAt: new Date("2026-03-29T00:03:00.000Z"),
        },
        {
          id: "terminal-codex-idle",
          projectId: "project-default",
          command: "codex",
          args: [],
          cwd: "/tmp/browser-viewer",
          activeCommand: "node",
          scrollback: "codex idle tail",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          lastActivityAt: new Date("2026-03-29T00:02:30.000Z"),
        },
        {
          id: "terminal-exited",
          projectId: "project-default",
          command: "node",
          args: [],
          cwd: "/tmp/old",
          activeCommand: "node",
          scrollback: "exited tail",
          status: "exited" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          lastActivityAt: new Date("2026-03-29T00:01:00.000Z"),
        },
      ],
    };
    const { server, terminalSessionManager, terminalStateService } =
      createTestServer(state);
    terminalStateService.handleAgentHook(
      "terminal-running",
      "codex",
      "UserPromptSubmit",
    );
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/app/home/overview`,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            terminalSessionId: "terminal-running",
            title: "codex · browser-viewer",
            subtitle: "/tmp/browser-viewer",
            displayStatus: "running",
            displayStatusLabel: "Agent Running",
            terminalState: { state: "agent_running", agent: "codex" },
            lastActivityAt: "2026-03-29T00:03:00.000Z",
          }),
          expect.objectContaining({
            terminalSessionId: "terminal-codex-idle",
            title: "codex · browser-viewer",
            displayStatus: "agent-idle",
            displayStatusLabel: "Agent Idle",
            terminalState: { state: "agent_idle", agent: "codex" },
          }),
          expect.objectContaining({
            terminalSessionId: "terminal-idle",
            title: "bash · demo",
            displayStatus: "idle",
            displayStatusLabel: "Idle",
            terminalState: { state: "shell_idle", agent: null },
          }),
          expect.objectContaining({
            terminalSessionId: "terminal-exited",
            displayStatus: "exited",
            displayStatusLabel: "Exited",
            terminalState: { state: "shell_idle", agent: null },
          }),
        ],
      }),
    );
    for (const session of payload.sessions) {
      expect(session).not.toHaveProperty("tailScrollback");
    }
    expect(terminalSessionManager.readLiveScrollback).not.toHaveBeenCalled();
    expect(terminalSessionManager.readScrollback).not.toHaveBeenCalled();
  });

  it("reports and cleans up tmux sessions that are missing from the store", async () => {
    const state = {
      current: null,
      sessions: [
        {
          id: "terminal-1",
          projectId: "project-default",
          command: "bash",
          args: ["-l"],
          cwd: "/tmp/demo",
          scrollback: "",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          runtimeKind: "tmux" as const,
          tmuxSessionName: "runweave-terminal-1",
        },
        {
          id: "terminal-2",
          projectId: "project-default",
          command: "bash",
          args: ["-l"],
          cwd: "/tmp/demo",
          scrollback: "",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          runtimeKind: "pty" as const,
        },
      ],
    };
    const orphan = {
      sessionName: "runweave-orphan",
      attachedClients: 0,
      windows: 1,
    };
    const attachedOrphan = {
      sessionName: "runweave-attached-orphan",
      attachedClients: 1,
      windows: 1,
    };
    const tmuxService = {
      buildSessionName: vi.fn((id: string) => `runweave-${id}`),
      listOrphanedSessions: vi.fn(async () => [orphan, attachedOrphan]),
      killOrphanedSessions: vi.fn(async () => [orphan]),
    };
    const { server } = createTestServer(state, { tmuxService });
    servers.push(server);
    const port = await startServer(server);

    const scanResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/tmux/orphans`,
    );
    expect(scanResponse.status).toBe(200);
    await expect(scanResponse.json()).resolves.toEqual({
      items: [orphan, attachedOrphan],
    });
    expect(tmuxService.listOrphanedSessions).toHaveBeenCalledWith(
      new Set(["runweave-terminal-1"]),
    );

    const missingConfirmResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/tmux/orphans`,
      { method: "DELETE" },
    );
    expect(missingConfirmResponse.status).toBe(400);

    const cleanupResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/tmux/orphans?confirm=true`,
      { method: "DELETE" },
    );
    expect(cleanupResponse.status).toBe(200);
    await expect(cleanupResponse.json()).resolves.toEqual({
      killed: [orphan],
      skipped: [attachedOrphan],
    });
    expect(tmuxService.killOrphanedSessions).toHaveBeenCalledWith(
      new Set(["runweave-terminal-1"]),
      { includeAttached: false },
    );
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
      command: "bash",
      args: ["-l"],
      cwd: "/tmp/demo",
      activeCommand: null,
      scrollback: "bash$ ls\nREADME.md\n",
      status: "exited",
      createdAt: "2026-03-29T00:00:00.000Z",
      lastActivityAt: "2026-03-29T00:00:00.000Z",
      exitCode: 0,
    });
  });

  it("reads tmux-backed terminal history from capture-pane", async () => {
    const state = {
      current: {
        id: "terminal-1",
        projectId: "project-default",
        name: "bash",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "persisted pty history",
        status: "running" as const,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
        runtimeKind: "tmux" as const,
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      },
    };
    const tmuxService = {
      capturePane: vi.fn(async () => ({
        data: "tmux pane history\n",
        durationMs: 12,
        sourceCols: 120,
      })),
    };
    const { server, terminalSessionManager } = createTestServer(state, {
      tmuxService,
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/history`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        terminalSessionId: "terminal-1",
        scrollback: "tmux pane history\n",
        scrollbackSourceCols: 120,
      }),
    );
    expect(terminalSessionManager.readScrollback).not.toHaveBeenCalled();
    expect(tmuxService.capturePane).toHaveBeenCalledWith({
      sessionName: "runweave-terminal-1",
      socketPath: "/tmp/runweave/tmux.sock",
    });
  });

  it("limits live terminal scrollback to the configured latest lines", async () => {
    const totalLineCount = TERMINAL_CLIENT_SCROLLBACK_LINES + 250;
    const scrollback = Array.from(
      { length: totalLineCount },
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
            `line-${index + (totalLineCount - TERMINAL_CLIENT_SCROLLBACK_LINES + 1)}`,
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

  it("kills tmux sessions when deleting terminal projects", async () => {
    const state = {
      current: null as MockTerminalSession | null,
      sessions: [
        {
          id: "terminal-1",
          projectId: "project-default",
          name: "tmux-shell",
          command: "bash",
          args: [],
          cwd: "/tmp/a",
          scrollback: "",
          status: "running" as const,
          createdAt: new Date("2026-03-29T00:00:00.000Z"),
          runtimeKind: "tmux" as const,
          tmuxSessionName: "runweave-terminal-1",
          tmuxSocketPath: "/tmp/runweave/tmux.sock",
        },
      ],
    };
    const tmuxService = {
      killSession: vi.fn(async () => undefined),
    };
    const { server } = createTestServer(state, { tmuxService });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(204);
    expect(tmuxService.killSession).toHaveBeenCalledWith({
      sessionName: "runweave-terminal-1",
      socketPath: "/tmp/runweave/tmux.sock",
    });
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
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-project-"),
    );
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
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-project-"),
    );
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
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
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
        readonly: false,
      }),
    );
  });

  it("renames and deletes project preview files through the project route", async () => {
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
    tempDirs.push(projectPath);
    await mkdir(path.join(projectPath, "docs"));
    const filePath = path.join(projectPath, "README.md");
    await writeFile(filePath, "# Project Preview\n");
    const before = await stat(filePath);
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

    const renameResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file/path`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "README.md",
          nextPath: "docs/renamed.md",
          expectedMtimeMs: before.mtimeMs,
        }),
      },
    );

    expect(renameResponse.status).toBe(200);
    await expect(renameResponse.json()).resolves.toEqual(
      expect.objectContaining({
        kind: "file",
        projectId: "project-default",
        path: "docs/renamed.md",
        language: "markdown",
        content: "# Project Preview\n",
        readonly: false,
      }),
    );
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
    const renamedPath = path.join(projectPath, "docs/renamed.md");
    const realRenamedPath = await realpath(renamedPath);
    const renamedStats = await stat(renamedPath);

    const deleteResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "docs/renamed.md",
          expectedMtimeMs: renamedStats.mtimeMs,
        }),
      },
    );

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      kind: "file-delete",
      projectId: "project-default",
      path: "docs/renamed.md",
      absolutePath: realRenamedPath,
    });
    await expect(readFile(renamedPath, "utf8")).rejects.toThrow();
  });

  it("returns preview mutate validation errors from the project route", async () => {
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
    tempDirs.push(projectPath);
    await mkdir(path.join(projectPath, "src"));
    await writeFile(path.join(projectPath, "README.md"), "# Project Preview\n");
    await writeFile(path.join(projectPath, "existing.md"), "exists\n");
    const outsideFile = path.join(
      os.tmpdir(),
      `terminal-preview-${Date.now()}.md`,
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

    const deleteDirectoryResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "src" }),
      },
    );
    const deleteOutsideResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: outsideFile }),
      },
    );
    const renameExistingResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file/path`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "README.md",
          nextPath: "existing.md",
        }),
      },
    );
    const renameMissingParentResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file/path`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "README.md",
          nextPath: "missing/renamed.md",
        }),
      },
    );
    const before = await stat(path.join(projectPath, "README.md"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(path.join(projectPath, "README.md"), "external\n");
    const renameConflictResponse = await fetch(
      `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/file/path`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "README.md",
          nextPath: "renamed.md",
          expectedMtimeMs: before.mtimeMs,
        }),
      },
    );

    expect(deleteDirectoryResponse.status).toBe(400);
    expect(deleteOutsideResponse.status).toBe(403);
    expect(renameExistingResponse.status).toBe(409);
    expect(renameMissingParentResponse.status).toBe(400);
    expect(renameConflictResponse.status).toBe(409);
  });

  it("serves project preview image assets with no-store caching", async () => {
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
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
    expect(Buffer.from(await response.arrayBuffer()).equals(imageBytes)).toBe(
      true,
    );
  });

  it("does not expose legacy session-scoped preview routes", async () => {
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
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

  it("opens absolute project preview paths outside the project path as read only", async () => {
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "terminal-outside-"),
    );
    tempDirs.push(projectPath, outsideDir);
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret\n");
    const realOutsideFile = await realpath(outsideFile);
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        kind: "file",
        path: realOutsideFile,
        absolutePath: realOutsideFile,
        base: "filesystem",
        content: "secret\n",
        readonly: true,
      }),
    );
  });

  it("rejects project preview files that symlink outside the project path", async () => {
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "terminal-outside-"),
    );
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
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
    tempDirs.push(projectPath);
    await mkdir(path.join(projectPath, "frontend/src/components/terminal"), {
      recursive: true,
    });
    await mkdir(path.join(projectPath, "docs/architecture"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        projectPath,
        "frontend/src/components/terminal/terminal-workspace.tsx",
      ),
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
    expect(payload.items.every((item) => !path.isAbsolute(item.path))).toBe(
      true,
    );
  });

  it("searches project preview files without returning gitignored files", async () => {
    const projectPath = await mkdtemp(
      path.join(os.tmpdir(), "terminal-preview-"),
    );
    tempDirs.push(projectPath);
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    await mkdir(path.join(projectPath, "generated"), { recursive: true });
    await writeFile(path.join(projectPath, ".gitignore"), "generated/\n");
    await writeFile(
      path.join(projectPath, "src/terminal-preview.ts"),
      "export {};\n",
    );
    await writeFile(
      path.join(projectPath, "generated/terminal-preview.js"),
      "ignored\n",
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
    const realRepo = await realpath(repo);
    await expect(diffResponse.json()).resolves.toEqual(
      expect.objectContaining({
        kind: "file-diff",
        changeKind: "staged",
        path: "staged.txt",
        absolutePath: path.join(realRepo, "staged.txt"),
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

  it("kills tmux sessions when deleting tmux-backed terminal sessions", async () => {
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
        runtimeKind: "tmux" as const,
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      },
    };
    const tmuxService = {
      killSession: vi.fn(async () => undefined),
    };
    const { server, runtimeRegistry } = createTestServer(state, {
      tmuxService,
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(204);
    expect(runtimeRegistry.disposeRuntime).toHaveBeenCalledWith("terminal-1");
    expect(tmuxService.killSession).toHaveBeenCalledWith({
      sessionName: "runweave-terminal-1",
      socketPath: "/tmp/runweave/tmux.sock",
    });
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

  it("accepts terminal input through the HTTP API", async () => {
    const runtime = {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
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
    const runtimeRegistry = {
      getRuntime: vi.fn(() => runtime),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const ptyService = {
      spawnSession: vi.fn(),
    };
    const { server } = createTestServer(state, {
      ptyService,
      runtimeRegistry,
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/input`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token-1",
        },
        body: JSON.stringify({
          operationId: "op-test-1",
          data: "pwd\r",
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operationId: "op-test-1",
      terminalSessionId: "terminal-1",
      inputAccepted: true,
      inputEnqueued: true,
      runtimeKind: "pty",
    });
    expect(runtime.write).toHaveBeenCalledWith("pwd\r");
    expect(ptyService.spawnSession).not.toHaveBeenCalled();
  });

  it("interrupts terminal sessions through the HTTP API with escape input", async () => {
    const runtime = {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
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
    const runtimeRegistry = {
      getRuntime: vi.fn(() => runtime),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const { server } = createTestServer(state, {
      ptyService: { spawnSession: vi.fn() },
      runtimeRegistry,
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/interrupt`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token-1",
        },
        body: JSON.stringify({ operationId: "op-interrupt-1" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operationId: "op-interrupt-1",
      terminalSessionId: "terminal-1",
      inputAccepted: true,
      inputEnqueued: true,
      interruptAccepted: true,
      interruptSequence: "escape",
      runtimeKind: "pty",
    });
    expect(runtime.write).toHaveBeenCalledWith("\x1b");
    expect(runtime.signal).not.toHaveBeenCalled();
  });

  it("sends HTTP terminal input directly to tmux-backed panes", async () => {
    const runtime = {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
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
        runtimeKind: "tmux" as const,
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      },
    };
    const runtimeRegistry = {
      getRuntime: vi.fn(() => runtime),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const tmuxService = {
      sendInput: vi.fn(async () => undefined),
      buildSessionName: vi.fn(() => "runweave-terminal-1"),
      socketPath: "/tmp/runweave/tmux.sock",
    };
    const { server } = createTestServer(state, {
      ptyService: { spawnSession: vi.fn() },
      runtimeRegistry,
      tmuxService,
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/input`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token-1",
        },
        body: JSON.stringify({
          operationId: "op-test-1",
          data: "codex prompt\r",
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operationId: "op-test-1",
      terminalSessionId: "terminal-1",
      inputAccepted: true,
      inputEnqueued: true,
      runtimeKind: "tmux",
    });
    expect(tmuxService.sendInput).toHaveBeenCalledWith(
      {
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      },
      "codex prompt\r",
    );
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it("interrupts tmux-backed panes through the HTTP API with escape input", async () => {
    const runtime = {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
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
        runtimeKind: "tmux" as const,
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
      },
    };
    const runtimeRegistry = {
      getRuntime: vi.fn(() => runtime),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const tmuxService = {
      sendInput: vi.fn(async () => undefined),
      buildSessionName: vi.fn(() => "runweave-terminal-1"),
      socketPath: "/tmp/runweave/tmux.sock",
    };
    const { server } = createTestServer(state, {
      ptyService: { spawnSession: vi.fn() },
      runtimeRegistry,
      tmuxService,
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/interrupt`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token-1",
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      terminalSessionId: "terminal-1",
      inputAccepted: true,
      inputEnqueued: true,
      interruptAccepted: true,
      interruptSequence: "escape",
      runtimeKind: "tmux",
    });
    expect(tmuxService.sendInput).toHaveBeenCalledWith(
      {
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      },
      "\x1b",
    );
    expect(runtime.signal).not.toHaveBeenCalled();
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it("returns an error when HTTP terminal input cannot be written", async () => {
    const runtime = {
      pid: 123,
      write: vi.fn(() => {
        throw new Error("pty write failed");
      }),
      resize: vi.fn(),
      signal: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
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
    const runtimeRegistry = {
      getRuntime: vi.fn(() => runtime),
      createRuntime: vi.fn(),
      ensureRecorder: vi.fn(),
      disposeRuntime: vi.fn(async () => undefined),
    };
    const { server } = createTestServer(state, {
      ptyService: { spawnSession: vi.fn() },
      runtimeRegistry,
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/terminal/session/terminal-1/input`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token-1",
        },
        body: JSON.stringify({ data: "pwd\r" }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      message: "Terminal input failed",
      error: expect.stringContaining("pty write failed"),
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
