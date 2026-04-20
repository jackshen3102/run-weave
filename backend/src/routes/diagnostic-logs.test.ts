import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticLogRecorder } from "../diagnostic-logs/recorder";
import { createDiagnosticLogsRouter } from "./diagnostic-logs";

function createTestServer() {
  const recorder = new DiagnosticLogRecorder();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/diagnostic-logs",
    createDiagnosticLogsRouter(recorder, { consoleLog: vi.fn() }),
  );
  const server = http.createServer(app);

  return { recorder, server };
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

describe("diagnostic log routes", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("returns null before a recording result exists", async () => {
    const { server } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/diagnostic-logs/result`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it("starts, stops, and returns the latest merged result", async () => {
    const { recorder, server } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const startResponse = await fetch(
      `http://127.0.0.1:${port}/api/diagnostic-logs/start`,
      { method: "POST" },
    );
    recorder.append({
      at: "2026-04-20T10:00:02.000Z",
      source: "backend",
      message: "backend",
    });
    const stopResponse = await fetch(
      `http://127.0.0.1:${port}/api/diagnostic-logs/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frontendLogs: [
            {
              at: "2026-04-20T10:00:01.000Z",
              source: "frontend",
              message: "frontend",
            },
          ],
        }),
      },
    );

    expect(startResponse.status).toBe(200);
    await expect(startResponse.json()).resolves.toEqual({
      status: "recording",
    });
    expect(stopResponse.status).toBe(200);
    const stoppedResult = (await stopResponse.json()) as {
      logs: Array<{ message: string }>;
    };
    expect(stoppedResult.logs.map((log) => log.message)).toEqual(
      expect.arrayContaining([
        "diagnostic recording started",
        "frontend",
        "backend",
        "diagnostic recording stopping",
      ]),
    );
    expect(stoppedResult.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "backend",
          message: "diagnostic recording started",
          details: { trigger: "http" },
        }),
        expect.objectContaining({
          source: "backend",
          message: "diagnostic recording stopping",
          details: { frontendLogCount: 1, trigger: "http" },
        }),
      ]),
    );

    const resultResponse = await fetch(
      `http://127.0.0.1:${port}/api/diagnostic-logs/result`,
    );
    await expect(resultResponse.json()).resolves.toMatchObject(stoppedResult);
  });

  it("does not expose a clear endpoint", async () => {
    const { recorder, server } = createTestServer();
    servers.push(server);
    const port = await startServer(server);
    recorder.start();
    recorder.append({
      at: "2026-04-20T10:00:00.000Z",
      message: "clear me",
    });
    recorder.stop();

    const clearResponse = await fetch(
      `http://127.0.0.1:${port}/api/diagnostic-logs/clear`,
      { method: "POST" },
    );
    const resultResponse = await fetch(
      `http://127.0.0.1:${port}/api/diagnostic-logs/result`,
    );

    expect(clearResponse.status).toBe(404);
    await expect(resultResponse.json()).resolves.toMatchObject({
      logs: [
        expect.objectContaining({
          message: "clear me",
        }),
      ],
    });
  });
});
