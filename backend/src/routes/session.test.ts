import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRouter } from "./session";
import { SessionProfileValidationError } from "../session/manager";

interface MockSession {
  id: string;
  targetUrl: string;
  proxyEnabled: boolean;
  profileMode: "managed" | "custom";
  connected: boolean;
  createdAt: Date;
}

function createTestServer(sessionState: { current: MockSession | null }) {
  const sessionManager = {
    createSession: vi.fn(
      async (options: {
        targetUrl: string;
        proxyEnabled: boolean;
        profilePath?: string;
      }) => {
        if (options.profilePath === "/missing") {
          throw new SessionProfileValidationError(
            "Custom profile path does not exist",
          );
        }
        const created: MockSession = {
          id: "test-session-id",
          targetUrl: options.targetUrl,
          proxyEnabled: options.proxyEnabled,
          profileMode: options.profilePath ? "custom" : "managed",
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
  app.use("/api", createSessionRouter(sessionManager as never));
  const server = http.createServer(app);

  return { server, sessionManager };
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
      body: JSON.stringify({ url: "https://example.com", proxyEnabled: true }),
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
      targetUrl: string;
      proxyEnabled: boolean;
      profileMode: "managed" | "custom";
    };
    expect(statusPayload.sessionId).toBe("test-session-id");
    expect(statusPayload.targetUrl).toBe("https://example.com");
    expect(statusPayload.proxyEnabled).toBe(true);
    expect(statusPayload.profileMode).toBe("managed");

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/session`);
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as Array<{
      sessionId: string;
      proxyEnabled: boolean;
      profileMode: "managed" | "custom";
    }>;
    expect(listPayload).toHaveLength(1);
    expect(listPayload[0]?.sessionId).toBe("test-session-id");
    expect(listPayload[0]?.proxyEnabled).toBe(true);
    expect(listPayload[0]?.profileMode).toBe("managed");

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

  it("returns a validation error for an invalid custom profile path", async () => {
    const state = { current: null as MockSession | null };
    const { server } = createTestServer(state);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com",
        proxyEnabled: false,
        profilePath: "/missing",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        message: "Custom profile path does not exist",
      }),
    );
  });
});
