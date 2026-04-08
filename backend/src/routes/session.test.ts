import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRouter } from "./session";

interface MockSession {
  id: string;
  name: string;
  preferredForAi?: boolean;
  persisted?: boolean;
  proxyEnabled: boolean;
  sourceType: "launch" | "connect-cdp";
  cdpEndpoint?: string;
  headers: Record<string, string>;
  connected: boolean;
  createdAt: Date;
}

function createTestServer(sessionState: { current: MockSession | null }) {
  const authService = {
    verifyAccessToken: vi.fn(() => ({
      sessionId: "auth-session-1",
      username: "admin",
    })),
    issueTemporaryToken: vi.fn(() => ({
      token: "ticket-123",
      expiresIn: 60,
    })),
  };
  const aiBridgeSessionController = {
    disconnectSession: vi.fn(() => true),
  };
  const sessionManager = {
    createSession: vi.fn(
      async (options: {
        name: string;
        preferredForAi?: boolean;
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
          preferredForAi: options.preferredForAi ?? false,
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
          persisted: options.source.type === "launch",
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
    updateSessionAiPreference: vi.fn(async (id: string, preferredForAi: boolean) => {
      if (sessionState.current?.id !== id) {
        return undefined;
      }

      sessionState.current = {
        ...sessionState.current,
        preferredForAi,
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
    getCollaborationState: vi.fn(() => ({
      controlOwner: "none",
      aiStatus: "idle",
      collaborationTabId: null,
      aiBridgeIssuedAt: null,
      aiBridgeExpiresAt: null,
      aiLastAction: null,
      aiLastError: null,
    })),
    onAiBridgeIssued: vi.fn(),
    onAiBridgeRevoked: vi.fn(),
  };

  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createSessionRouter(
      sessionManager as never,
      authService as never,
      aiBridgeSessionController as never,
    ),
  );
  const server = http.createServer(app);

  return { server, sessionManager, authService, aiBridgeSessionController };
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
      preferredForAi: false,
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

  it("rejects a non-persisted cdp session as preferred ai default", async () => {
    const state = { current: null as MockSession | null };
    const { server, sessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "CDP Playweight",
        preferredForAi: true,
        source: {
          type: "connect-cdp",
          endpoint: "http://127.0.0.1:9333",
        },
      }),
    });

    expect(createResponse.status).toBe(400);
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it("creates and updates the preferred ai session", async () => {
    const state = { current: null as MockSession | null };
    const { server, sessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "AI session",
        preferredForAi: true,
        source: {
          type: "launch",
          proxyEnabled: false,
        },
      }),
    });

    expect(createResponse.status).toBe(201);
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      name: "AI session",
      preferredForAi: true,
      source: expect.objectContaining({
        type: "launch",
        proxyEnabled: false,
      }),
    });

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/session`);
    const listPayload = (await listResponse.json()) as Array<{
      preferredForAi?: boolean;
    }>;
    expect(listPayload[0]?.preferredForAi).toBe(true);

    const updateResponse = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id/ai-preference`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredForAi: false }),
      },
    );

    expect(updateResponse.status).toBe(200);
    expect(sessionManager.updateSessionAiPreference).toHaveBeenCalledWith(
      "test-session-id",
      false,
    );
  });

  it("rejects setting ai default on a non-persisted session", async () => {
    const state = {
      current: {
        id: "test-session-id",
        name: "CDP session",
        preferredForAi: false,
        persisted: false,
        proxyEnabled: false,
        sourceType: "connect-cdp" as const,
        cdpEndpoint: "http://127.0.0.1:9333",
        headers: {},
        connected: false,
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    };
    const { server, sessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id/ai-preference`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredForAi: true }),
      },
    );

    expect(response.status).toBe(400);
    expect(sessionManager.updateSessionAiPreference).not.toHaveBeenCalled();
  });

  it("returns 404 when no preferred ai session exists", async () => {
    const state = { current: null as MockSession | null };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/ai-default`,
    );

    expect(response.status).toBe(404);
  });

  it("returns the preferred ai session", async () => {
    const state = {
      current: {
        id: "test-session-id",
        name: "AI session",
        preferredForAi: true,
        proxyEnabled: false,
        sourceType: "launch" as const,
        headers: {},
        connected: true,
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/ai-default`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      sessionId: string;
      preferredForAi: boolean;
      name: string;
    };
    expect(payload.sessionId).toBe("test-session-id");
    expect(payload.preferredForAi).toBe(true);
    expect(payload.name).toBe("AI session");
  });

  it("ensures a preferred ai session exists", async () => {
    const state = { current: null as MockSession | null };
    const { server, sessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/ai-default/ensure`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Reusable AI session" }),
      },
    );

    expect(response.status).toBe(201);
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      name: "Reusable AI session",
      preferredForAi: true,
      source: { type: "launch" },
    });

    const payload = (await response.json()) as {
      sessionId: string;
      preferredForAi: boolean;
      name: string;
    };
    expect(payload.sessionId).toBe("test-session-id");
    expect(payload.preferredForAi).toBe(true);
    expect(payload.name).toBe("Reusable AI session");
  });

  it("reuses the existing preferred ai session during ensure", async () => {
    const state = {
      current: {
        id: "test-session-id",
        name: "Existing AI session",
        preferredForAi: true,
        proxyEnabled: false,
        sourceType: "launch" as const,
        headers: {},
        connected: true,
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    };
    const { server, sessionManager } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/session/ai-default/ensure`,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    const payload = (await response.json()) as {
      sessionId: string;
      preferredForAi: boolean;
      name: string;
    };
    expect(payload.sessionId).toBe("test-session-id");
    expect(payload.preferredForAi).toBe(true);
    expect(payload.name).toBe("Existing AI session");
  });

  it("creates and revokes an AI bridge", async () => {
    const state = {
      current: {
        id: "test-session-id",
        name: "Default Playweight",
        proxyEnabled: false,
        sourceType: "launch" as const,
        headers: {},
        connected: true,
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    };
    const { server, authService, sessionManager, aiBridgeSessionController } =
      createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const createResponse = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id/ai-bridge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
          Host: `127.0.0.1:${port}`,
        },
        body: JSON.stringify({ tabId: "target-1" }),
      },
    );

    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      bridgeUrl: string;
    };
    expect(created.bridgeUrl).toBe(
      `ws://127.0.0.1:${port}/ws/ai-bridge?sessionId=test-session-id`,
    );
    expect(authService.issueTemporaryToken).not.toHaveBeenCalled();
    expect(sessionManager.onAiBridgeIssued).toHaveBeenCalledWith(
      "test-session-id",
      expect.objectContaining({
        collaborationTabId: "target-1",
      }),
    );

    const revokeResponse = await fetch(
      `http://127.0.0.1:${port}/api/session/test-session-id/ai-bridge`,
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer token",
        },
      },
    );

    expect(revokeResponse.status).toBe(204);
    expect(aiBridgeSessionController.disconnectSession).toHaveBeenCalledWith(
      "test-session-id",
      "AI bridge revoked",
    );
    expect(sessionManager.onAiBridgeRevoked).toHaveBeenCalledWith(
      "test-session-id",
    );
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
      preferredForAi: false,
      source: expect.objectContaining({
        type: "launch",
        proxyEnabled: false,
      }),
    });
  });

  it("issues a short-lived viewer websocket ticket for an existing session", async () => {
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
      `http://127.0.0.1:${port}/api/session/test-session-id/ws-ticket`,
      {
        method: "POST",
        headers: { Authorization: "Bearer access-token-1" },
      },
    );

    expect(response.status).toBe(200);
    expect(authService.issueTemporaryToken).toHaveBeenCalledWith({
      sessionId: "auth-session-1",
      tokenType: "viewer-ws",
      resource: { sessionId: "test-session-id" },
      ttlMs: 60_000,
    });
    const payload = (await response.json()) as {
      ticket: string;
      expiresIn: number;
    };
    expect(payload.ticket).toBe("ticket-123");
    expect(payload.expiresIn).toBe(60);
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
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token-1",
        },
        body: JSON.stringify({ tabId: "tab-1" }),
      },
    );

    expect(response.status).toBe(200);
    expect(authService.issueTemporaryToken).toHaveBeenCalledWith({
      sessionId: "auth-session-1",
      tokenType: "devtools",
      resource: { sessionId: "test-session-id", tabId: "tab-1" },
      ttlMs: 60_000,
    });
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
