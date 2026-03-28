import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRouter } from "./session";

interface MockSession {
  id: string;
  name: string;
  proxyEnabled: boolean;
  sourceType: "launch" | "connect-cdp";
  cdpEndpoint?: string;
  headers: Record<string, string>;
  connected: boolean;
  createdAt: Date;
}

function createTestServer(sessionState: { current: MockSession | null }) {
  const authService = {
    issueTemporaryToken: vi.fn(() => ({
      token: "ticket-123",
      expiresIn: 60,
    })),
  };
  const sessionManager = {
    createSession: vi.fn(
      async (options: {
        name: string;
        source:
          | {
              type: "launch";
              proxyEnabled: boolean;
              headers: Record<string, string>;
            }
          | {
              type: "connect-cdp";
              endpoint: string;
            };
      }) => {
        const created: MockSession = {
          id: "test-session-id",
          name: options.name,
          proxyEnabled:
            options.source.type === "launch"
              ? options.source.proxyEnabled
              : false,
          sourceType: options.source.type,
          cdpEndpoint:
            options.source.type === "connect-cdp"
              ? options.source.endpoint
              : undefined,
          headers:
            options.source.type === "launch" ? options.source.headers : {},
          connected: false,
          createdAt: new Date("2026-03-19T00:00:00.000Z"),
        };
        sessionState.current = created;
        return { ...created, browserSession: {} };
      },
    ),
    getSession: vi.fn((id: string) =>
      sessionState.current?.id === id ? sessionState.current : undefined,
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
    listSessions: vi.fn(() =>
      sessionState.current
        ? [
            {
              ...sessionState.current,
              lastActivityAt: new Date("2026-03-19T00:00:30.000Z"),
            },
          ]
        : [],
    ),
  };

  const app = express();
  app.use(express.json());
  app.use("/api", createSessionRouter(sessionManager as never, authService as never));
  const server = http.createServer(app);

  return { server, sessionManager, authService };
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

describe("session routes", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("creates, fetches and deletes session", async () => {
    const state = { current: null as MockSession | null };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Default Playweight",
        source: {
          type: "launch",
          proxyEnabled: true,
          headers: {
            "x-session-id": "test-session-id",
          },
        },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      sessionId: string;
      viewerUrl: string;
    };
    expect(created.sessionId).toBe("test-session-id");
    expect(created.viewerUrl).toContain("sessionId=test-session-id");

    const getResponse = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id`,
    );
    expect(getResponse.status).toBe(200);
    const statusPayload = (await getResponse.json()) as {
      sessionId: string;
      name: string;
      proxyEnabled: boolean;
      sourceType: "launch" | "connect-cdp";
      headers: Record<string, string>;
    };
    expect(statusPayload.sessionId).toBe("test-session-id");
    expect(statusPayload.name).toBe("Default Playweight");
    expect(statusPayload.proxyEnabled).toBe(true);
    expect(statusPayload.sourceType).toBe("launch");
    expect(statusPayload.headers).toEqual({
      "x-session-id": "test-session-id",
    });

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/session`);
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as Array<{
      sessionId: string;
      name: string;
      proxyEnabled: boolean;
      sourceType: "launch" | "connect-cdp";
      headers: Record<string, string>;
    }>;
    expect(listPayload).toHaveLength(1);
    expect(listPayload[0]?.sessionId).toBe("test-session-id");
    expect(listPayload[0]?.name).toBe("Default Playweight");
    expect(listPayload[0]?.proxyEnabled).toBe(true);
    expect(listPayload[0]?.sourceType).toBe("launch");
    expect(listPayload[0]?.headers).toEqual({
      "x-session-id": "test-session-id",
    });

    const deleteResponse = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id`,
      {
        method: "DELETE",
      },
    );
    expect(deleteResponse.status).toBe(204);

    const missingResponse = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id`,
    );
    expect(missingResponse.status).toBe(404);
  });

  it("creates an attached CDP session", async () => {
    const state = { current: null as MockSession | null };
    const { server, sessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "CDP Playweight",
        source: {
          type: "connect-cdp",
          endpoint: "http://127.0.0.1:9333",
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      name: "CDP Playweight",
      source: {
        type: "connect-cdp",
        endpoint: "http://127.0.0.1:9333",
      },
    });

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/session`);
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as Array<{
      sessionId: string;
      sourceType: "launch" | "connect-cdp";
      cdpEndpoint?: string;
    }>;
    expect(listPayload[0]?.sourceType).toBe("connect-cdp");
    expect(listPayload[0]?.cdpEndpoint).toBe("http://127.0.0.1:9333");
  });

  it("accepts legacy create-session payloads that only provide url", async () => {
    const state = { current: null as MockSession | null };
    const { server, sessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "http://127.0.0.1:5501/test/child",
        source: {
          type: "launch",
          proxyEnabled: false,
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      name: "http://127.0.0.1:5501/test/child",
      source: expect.objectContaining({
        type: "launch",
        proxyEnabled: false,
      }),
    });
  });

  it("issues a short-lived devtools ticket for an existing session", async () => {
    const state = {
      current: {
        id: "test-session-id",
        name: "Default Playweight",
        proxyEnabled: false,
        sourceType: "launch" as const,
        headers: {},
        connected: false,
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    };
    const { server, authService } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id/devtools-ticket`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId: "tab-1" }),
      },
    );

    expect(response.status).toBe(200);
    expect(authService.issueTemporaryToken).toHaveBeenCalledWith(
      "devtools",
      60_000,
    );
    const payload = (await response.json()) as {
      ticket: string;
      expiresIn: number;
    };
    expect(payload.ticket).toBe("ticket-123");
    expect(payload.expiresIn).toBe(60);
  });

  it("renames an existing session", async () => {
    const state = {
      current: {
        id: "test-session-id",
        name: "Default Playweight",
        proxyEnabled: false,
        sourceType: "launch" as const,
        headers: {},
        connected: false,
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    };
    const { server, sessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed session" }),
      },
    );

    expect(response.status).toBe(200);
    expect(sessionManager.updateSessionName).toHaveBeenCalledWith(
      "test-session-id",
      "Renamed session",
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        sessionId: "test-session-id",
        name: "Renamed session",
      }),
    );
  });
});
