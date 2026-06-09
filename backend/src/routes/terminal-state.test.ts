import http from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  createInternalTerminalAgentHookRouter,
  createTerminalStateRouter,
} from "./terminal-state";
import { TerminalStateService } from "../terminal/terminal-state-service";
import { TerminalStateStore } from "../terminal/terminal-state-store";

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

function createTestServer() {
  const session = {
    id: "terminal-1",
    projectId: "project-default",
    command: "bash",
    args: [],
    cwd: "/tmp/demo",
    activeCommand: "codex",
    scrollback: "",
    status: "running" as const,
    createdAt: new Date("2026-03-29T00:00:00.000Z"),
    lastActivityAt: new Date("2026-03-29T00:00:00.000Z"),
  };
  const terminalSessionManager = {
    getSession: (id: string) => (id === session.id ? session : undefined),
    getLastAiActiveCommand: () => null,
  };
  const terminalStateService = new TerminalStateService(
    new TerminalStateStore(),
  );
  const app = express();
  app.use(express.json());
  app.use(
    "/internal/terminal/agent-hook",
    createInternalTerminalAgentHookRouter({
      terminalSessionManager: terminalSessionManager as never,
      terminalStateService,
      hookToken: "hook-token",
    }),
  );
  app.use(
    "/api/terminal",
    createTerminalStateRouter({
      terminalSessionManager: terminalSessionManager as never,
      terminalStateService,
    }),
  );
  return { server: http.createServer(app) };
}

describe("terminal state routes", () => {
  it("records codex agent hooks into terminal state", async () => {
    const { server } = createTestServer();
    try {
      const port = await startServer(server);

      const runningResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal/agent-hook`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            agent: "codex",
            hookEvent: "UserPromptSubmit",
          }),
        },
      );
      expect(runningResponse.status).toBe(202);
      await expect(runningResponse.json()).resolves.toEqual({
        terminalState: { state: "agent_running", agent: "codex" },
      });

      const stopResponse = await fetch(
        `http://127.0.0.1:${port}/internal/terminal/agent-hook`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Runweave-Hook-Token": "hook-token",
          },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            agent: "codex",
            hookEvent: "Stop",
          }),
        },
      );
      expect(stopResponse.status).toBe(202);

      await expect(
        fetch(
          `http://127.0.0.1:${port}/api/terminal/session/terminal-1/state`,
        ).then((response) => response.json()),
      ).resolves.toEqual({
        terminalState: { state: "agent_idle", agent: "codex" },
      });
    } finally {
      await stopServer(server);
    }
  });

  it("rejects agent hooks without the hook token", async () => {
    const { server } = createTestServer();
    try {
      const port = await startServer(server);
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/terminal/agent-hook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            terminalSessionId: "terminal-1",
            agent: "codex",
            hookEvent: "Stop",
          }),
        },
      );

      expect(response.status).toBe(401);
    } finally {
      await stopServer(server);
    }
  });
});
