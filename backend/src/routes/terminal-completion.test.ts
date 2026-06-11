import http from "node:http";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { TerminalCompletionEventService } from "../terminal/completion-event-service";
import { TerminalEventService } from "../terminal/terminal-event-service";
import { createInternalTerminalCompletionRouter } from "./terminal-completion";
import { createTerminalRouter } from "./terminal";

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

function createCompletionEventService(): TerminalCompletionEventService {
  return new TerminalCompletionEventService(new TerminalEventService());
}

describe("terminal completion routes", () => {
  it("records internal hook events and exposes them through terminal API", async () => {
    const completionEventService = createCompletionEventService();
    const terminalSessionManager = {
      getSession: () => ({
        id: "terminal-1",
        projectId: "project-default",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: "codex",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
        runtimeKind: "tmux" as const,
      }),
      getLastAiActiveCommand: () => null,
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventService,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventService,
      }),
    );
    const server = http.createServer(app);

    try {
      const port = await startServer(server);
      const recordResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal-completion`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            source: "codex",
            hookEvent: "Stop",
            cwd: "/tmp/demo",
          }),
        },
      );

      expect(recordResponse.status).toBe(202);

      const listResponse = await fetch(
        `http://127.0.0.1:${port}/api/terminal/completion-events`,
      );
      await expect(listResponse.json()).resolves.toMatchObject({
        events: [
          {
            id: "1",
            kind: "completion",
            terminalSessionId: "terminal-1",
            projectId: "project-default",
            payload: {
              source: "codex",
              hookEvent: "Stop",
              cwd: "/tmp/demo",
            },
          },
        ],
      });
    } finally {
      await stopServer(server);
    }
  });

  it("records codex completion events for codex sessions when tmux reports node", async () => {
    const completionEventService = createCompletionEventService();
    const terminalSessionManager = {
      getSession: () => ({
        id: "terminal-1",
        projectId: "project-default",
        command: "codex",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: "node",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
        runtimeKind: "tmux" as const,
      }),
      getLastAiActiveCommand: () => null,
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventService,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventService,
      }),
    );
    const server = http.createServer(app);

    try {
      const port = await startServer(server);
      const recordResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal-completion`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            source: "codex",
            rawHookEvent: "Stop",
          }),
        },
      );

      expect(recordResponse.status).toBe(202);

      const listResponse = await fetch(
        `http://127.0.0.1:${port}/api/terminal/completion-events`,
      );
      await expect(listResponse.json()).resolves.toMatchObject({
        events: [
          {
            id: "1",
            kind: "completion",
            terminalSessionId: "terminal-1",
            payload: {
              source: "codex",
              hookEvent: "Stop",
            },
          },
        ],
      });
    } finally {
      await stopServer(server);
    }
  });

  it("rejects internal hook events without the hook token", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventService: createCompletionEventService(),
        terminalSessionManager: { getSession: () => undefined } as never,
        hookToken: "hook-token",
      }),
    );
    const server = http.createServer(app);

    try {
      const port = await startServer(server);
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/terminal-completion`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            source: "codex",
            hookEvent: "Stop",
          }),
        },
      );

      expect(response.status).toBe(401);
    } finally {
      await stopServer(server);
    }
  });

  it("ignores completion events when the pane is not running codex", async () => {
    const completionEventService = createCompletionEventService();
    const terminalSessionManager = {
      getSession: () => ({
        id: "terminal-1",
        projectId: "project-default",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: null,
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
        runtimeKind: "tmux" as const,
      }),
      getLastAiActiveCommand: () => null,
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventService,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventService,
      }),
    );
    const server = http.createServer(app);

    try {
      const port = await startServer(server);
      const recordResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal-completion`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            source: "codex",
            completionReason: "hook_stop",
            rawHookEvent: "Stop",
          }),
        },
      );

      expect(recordResponse.status).toBe(202);
      await expect(recordResponse.json()).resolves.toMatchObject({
        ignored: true,
      });

      const listResponse = await fetch(
        `http://127.0.0.1:${port}/api/terminal/completion-events`,
      );
      await expect(listResponse.json()).resolves.toMatchObject({ events: [] });
    } finally {
      await stopServer(server);
    }
  });

  it("records late completion events inside the active command grace window", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const completionEventService = createCompletionEventService();
    const terminalSessionManager = {
      getSession: () => ({
        id: "terminal-1",
        projectId: "project-default",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: null,
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
        runtimeKind: "tmux" as const,
      }),
      getLastAiActiveCommand: () => ({
        command: "codex",
        source: "codex" as const,
        observedAt: 1_000,
        clearedAt: 10_000,
      }),
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventService,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventService,
      }),
    );
    const server = http.createServer(app);

    try {
      const port = await startServer(server);
      const recordResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal-completion`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            source: "codex",
            completionReason: "hook_stop",
            rawHookEvent: "Stop",
          }),
        },
      );

      expect(recordResponse.status).toBe(202);
      const listResponse = await fetch(
        `http://127.0.0.1:${port}/api/terminal/completion-events`,
      );
      await expect(listResponse.json()).resolves.toMatchObject({
        events: [
          {
            kind: "completion",
            terminalSessionId: "terminal-1",
            payload: {
              source: "codex",
              rawHookEvent: "Stop",
            },
          },
        ],
      });
    } finally {
      nowSpy.mockRestore();
      await stopServer(server);
    }
  });

  it("ignores late completion events outside the active command grace window", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(40_001);
    const completionEventService = createCompletionEventService();
    const terminalSessionManager = {
      getSession: () => ({
        id: "terminal-1",
        projectId: "project-default",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: null,
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
        runtimeKind: "tmux" as const,
      }),
      getLastAiActiveCommand: () => ({
        command: "codex",
        source: "codex" as const,
        observedAt: 1_000,
        clearedAt: 10_000,
      }),
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventService,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventService,
      }),
    );
    const server = http.createServer(app);

    try {
      const port = await startServer(server);
      const recordResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal-completion`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            source: "codex",
            completionReason: "hook_stop",
            rawHookEvent: "Stop",
          }),
        },
      );

      expect(recordResponse.status).toBe(202);
      await expect(recordResponse.json()).resolves.toMatchObject({
        ignored: true,
      });
      const listResponse = await fetch(
        `http://127.0.0.1:${port}/api/terminal/completion-events`,
      );
      await expect(listResponse.json()).resolves.toMatchObject({ events: [] });
    } finally {
      nowSpy.mockRestore();
      await stopServer(server);
    }
  });

  it("ignores completion events from non-codex sources", async () => {
    const completionEventService = createCompletionEventService();
    const terminalSessionManager = {
      getSession: () => ({
        id: "terminal-1",
        projectId: "project-default",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: "codex",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
        runtimeKind: "tmux" as const,
      }),
      getLastAiActiveCommand: () => null,
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventService,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventService,
      }),
    );
    const server = http.createServer(app);

    try {
      const port = await startServer(server);
      const recordResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal-completion`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            source: "claude",
            completionReason: "hook_stop",
            rawHookEvent: "Stop",
          }),
        },
      );

      expect(recordResponse.status).toBe(202);
      await expect(recordResponse.json()).resolves.toMatchObject({
        ignored: true,
      });

      const listResponse = await fetch(
        `http://127.0.0.1:${port}/api/terminal/completion-events`,
      );
      await expect(listResponse.json()).resolves.toMatchObject({ events: [] });
    } finally {
      await stopServer(server);
    }
  });

  it.each(["trae", "traex", "traecli"])(
    "records trae completion events when the pane is running %s",
    async (activeCommand) => {
      const completionEventService = createCompletionEventService();
      const terminalSessionManager = {
        getSession: () => ({
          id: "terminal-1",
          projectId: "project-default",
          command: "bash",
          args: [],
          cwd: "/tmp/demo",
          activeCommand,
          scrollback: "",
          status: "running" as const,
          createdAt: new Date("2026-04-28T00:00:00.000Z"),
          runtimeKind: "tmux" as const,
        }),
        getLastAiActiveCommand: () => null,
        listProjects: () => [],
        listSessions: () => [],
      };
      const app = express();
      app.use(express.json());
      app.use(
        "/internal/terminal-completion",
        createInternalTerminalCompletionRouter({
          completionEventService,
          terminalSessionManager: terminalSessionManager as never,
          hookToken: "hook-token",
        }),
      );
      app.use(
        "/api/terminal",
        createTerminalRouter(terminalSessionManager as never, {
          completionEventService,
        }),
      );
      const server = http.createServer(app);

      try {
        const port = await startServer(server);
        const recordResponse = await fetch(
          `http://127.0.0.1:${port}/internal/terminal-completion`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Runweave-Hook-Token": "hook-token",
            },
            body: JSON.stringify({
              terminalSessionId: "terminal-1",
              source: "trae",
              completionReason: "hook_stop",
              rawHookEvent: "stop",
            }),
          },
        );

        expect(recordResponse.status).toBe(202);
        const listResponse = await fetch(
          `http://127.0.0.1:${port}/api/terminal/completion-events`,
        );
        await expect(listResponse.json()).resolves.toMatchObject({
          events: [
            {
              kind: "completion",
              terminalSessionId: "terminal-1",
              payload: {
                source: "trae",
              },
            },
          ],
        });
      } finally {
        await stopServer(server);
      }
    },
  );

  it("ignores trae completion events when the pane is not running a trae CLI", async () => {
    const completionEventService = createCompletionEventService();
    const terminalSessionManager = {
      getSession: () => ({
        id: "terminal-1",
        projectId: "project-default",
        command: "bash",
        args: [],
        cwd: "/tmp/demo",
        activeCommand: "codex",
        scrollback: "",
        status: "running" as const,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
        runtimeKind: "tmux" as const,
      }),
      getLastAiActiveCommand: () => null,
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventService,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventService,
      }),
    );
    const server = http.createServer(app);

    try {
      const port = await startServer(server);
      const recordResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal-completion`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            source: "trae",
            completionReason: "hook_stop",
            rawHookEvent: "stop",
          }),
        },
      );

      expect(recordResponse.status).toBe(202);
      await expect(recordResponse.json()).resolves.toMatchObject({
        ignored: true,
      });

      const listResponse = await fetch(
        `http://127.0.0.1:${port}/api/terminal/completion-events`,
      );
      await expect(listResponse.json()).resolves.toMatchObject({ events: [] });
    } finally {
      await stopServer(server);
    }
  });
});
