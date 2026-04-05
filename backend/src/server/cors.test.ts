import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createCorsMiddleware } from "./cors";

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

describe("createCorsMiddleware", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("allows electron auth headers in preflight responses", async () => {
    const app = express();
    app.use(createCorsMiddleware(["browser-viewer://app"]));
    app.post("/api/auth/login", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const server = http.createServer(app);
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "OPTIONS",
      headers: {
        Origin: "browser-viewer://app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "content-type,x-auth-client,x-connection-id",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "browser-viewer://app",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-Auth-Client",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-Connection-Id",
    );
  });
});
