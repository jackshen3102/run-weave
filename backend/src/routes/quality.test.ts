import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QualityProbeStore } from "../quality/probe-store";
import { createQualityRouter } from "./quality";

function createTestServer(options?: {
  probeStore?: QualityProbeStore;
  wsSessionController?: {
    getSessionConnectionCount: ReturnType<typeof vi.fn>;
    disconnectSession: ReturnType<typeof vi.fn>;
  };
}) {
  const probeStore = options?.probeStore ?? new QualityProbeStore();
  const wsSessionController =
    options?.wsSessionController ??
    ({
      getSessionConnectionCount: vi.fn(() => 0),
      disconnectSession: vi.fn(() => false),
    } as const);

  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createQualityRouter(probeStore, wsSessionController as never),
  );
  const server = http.createServer(app);

  return {
    server,
    probeStore,
    wsSessionController,
  };
}

function createServerWithoutWsController(probeStore?: QualityProbeStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createQualityRouter(probeStore ?? new QualityProbeStore()));
  const server = http.createServer(app);

  return { server };
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

describe("quality routes", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("returns session quality details for an existing probe session", async () => {
    const { server, probeStore } = createTestServer();
    probeStore.createSession("session-1");
    probeStore.updateTabState("session-1", {
      activeTabId: "tab-1",
      tabCount: 1,
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/quality/session/session-1`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      snapshot: {
        sessionId: string;
        activeTabId: string | null;
        tabCount: number;
      };
      timeline: Array<{ type: string }>;
    };
    expect(payload.snapshot).toMatchObject({
      sessionId: "session-1",
      activeTabId: "tab-1",
      tabCount: 1,
    });
    expect(payload.timeline[0]?.type).toBe("session.created");
  });

  it("returns 404 when a quality session is missing", async () => {
    const { server } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/quality/session/missing`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      message: "Quality session not found",
    });
  });

  it("resets a quality session timeline and snapshot", async () => {
    const { server, probeStore } = createTestServer();
    probeStore.createSession("session-reset");
    probeStore.markViewerConnected("session-reset", true);
    probeStore.markFirstFrame("session-reset");
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/quality/session/session-reset/reset`,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      snapshot: {
        sessionId: string;
        viewerConnected: boolean;
        firstFrameAt: string | null;
        milestones: Record<string, boolean>;
      };
      timeline: Array<{ type: string; details?: Record<string, boolean> }>;
    };
    expect(payload.snapshot).toMatchObject({
      sessionId: "session-reset",
      viewerConnected: false,
      firstFrameAt: null,
      milestones: {
        firstFrame: false,
        viewerConnected: false,
      },
    });
    expect(payload.timeline).toEqual([
      expect.objectContaining({
        type: "session.created",
        details: { reset: true },
      }),
    ]);
  });

  it("returns active websocket connection counts", async () => {
    const { server, wsSessionController } = createTestServer({
      wsSessionController: {
        getSessionConnectionCount: vi.fn(() => 2),
        disconnectSession: vi.fn(() => false),
      },
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/quality/session/session-1/connections`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connectionCount: 2,
    });
    expect(wsSessionController.getSessionConnectionCount).toHaveBeenCalledWith(
      "session-1",
    );
  });

  it("disconnects an active websocket session", async () => {
    const { server, wsSessionController } = createTestServer({
      wsSessionController: {
        getSessionConnectionCount: vi.fn(() => 0),
        disconnectSession: vi.fn(() => true),
      },
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/quality/session/session-1/disconnect`,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ disconnected: true });
    expect(wsSessionController.disconnectSession).toHaveBeenCalledWith(
      "session-1",
    );
  });

  it("returns 404 when disconnecting an unknown websocket session", async () => {
    const { server } = createTestServer({
      wsSessionController: {
        getSessionConnectionCount: vi.fn(() => 0),
        disconnectSession: vi.fn(() => false),
      },
    });
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/quality/session/missing/disconnect`,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      message: "Active websocket session not found",
    });
  });

  it("returns 503 for websocket control endpoints when unavailable", async () => {
    const { server } = createServerWithoutWsController();
    servers.push(server);
    const port = await startServer(server);

    const [connectionsResponse, disconnectResponse] = await Promise.all([
      fetch(
        `http://127.0.0.1:${port}/api/quality/session/session-1/connections`,
      ),
      fetch(
        `http://127.0.0.1:${port}/api/quality/session/session-1/disconnect`,
        {
          method: "POST",
        },
      ),
    ]);

    expect(connectionsResponse.status).toBe(503);
    await expect(connectionsResponse.json()).resolves.toEqual({
      message: "WebSocket session control unavailable",
    });
    expect(disconnectResponse.status).toBe(503);
    await expect(disconnectResponse.json()).resolves.toEqual({
      message: "WebSocket session control unavailable",
    });
  });
});
