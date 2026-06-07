import http from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";
import { TerminalCompletionEventStore } from "../terminal/completion-events";
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

describe("terminal completion routes", () => {
  it("records internal hook events and exposes them through terminal API", async () => {
    const completionEventStore = new TerminalCompletionEventStore();
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
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventStore,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventStore,
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
            terminalSessionId: "terminal-1",
            projectId: "project-default",
            source: "codex",
            hookEvent: "Stop",
            cwd: "/tmp/demo",
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
        completionEventStore: new TerminalCompletionEventStore(),
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
    const completionEventStore = new TerminalCompletionEventStore();
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
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventStore,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventStore,
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

  it("ignores completion events from non-codex sources", async () => {
    const completionEventStore = new TerminalCompletionEventStore();
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
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventStore,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventStore,
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
      const completionEventStore = new TerminalCompletionEventStore();
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
        listProjects: () => [],
        listSessions: () => [],
      };
      const app = express();
      app.use(express.json());
      app.use(
        "/internal/terminal-completion",
        createInternalTerminalCompletionRouter({
          completionEventStore,
          terminalSessionManager: terminalSessionManager as never,
          hookToken: "hook-token",
        }),
      );
      app.use(
        "/api/terminal",
        createTerminalRouter(terminalSessionManager as never, {
          completionEventStore,
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
              terminalSessionId: "terminal-1",
              source: "trae",
            },
          ],
        });
      } finally {
        await stopServer(server);
      }
    },
  );

  it("ignores trae completion events when the pane is not running a trae CLI", async () => {
    const completionEventStore = new TerminalCompletionEventStore();
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
      listProjects: () => [],
      listSessions: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/internal/terminal-completion",
      createInternalTerminalCompletionRouter({
        completionEventStore,
        terminalSessionManager: terminalSessionManager as never,
        hookToken: "hook-token",
      }),
    );
    app.use(
      "/api/terminal",
      createTerminalRouter(terminalSessionManager as never, {
        completionEventStore,
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
