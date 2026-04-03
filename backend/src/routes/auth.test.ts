import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRouter } from "./auth";

function createTestServer() {
  const authService = {
    login: vi.fn((username: string, password: string) => {
      if (username !== "admin" || password !== "secret") {
        return null;
      }

      return {
        token: "token-abc",
        expiresIn: 3600,
      };
    }),
    verifyToken: vi.fn((token: string) => token === "token-abc"),
  };

  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter(authService as never));
  const server = http.createServer(app);

  return { server, authService };
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

describe("auth routes", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("returns token for valid credentials", async () => {
    const { server } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      token: string;
      expiresIn: number;
    };
    expect(payload.token).toBe("token-abc");
    expect(payload.expiresIn).toBe(3600);
  });

  it("rejects invalid credentials", async () => {
    const { server } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });

    expect(response.status).toBe(401);
  });

  it("verifies a valid bearer token", async () => {
    const { server, authService } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/verify`, {
      headers: { Authorization: "Bearer token-abc" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });
    expect(authService.verifyToken).toHaveBeenCalledWith("token-abc");
  });

  it("rejects an invalid bearer token", async () => {
    const { server } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/verify`, {
      headers: { Authorization: "Bearer wrong-token" },
    });

    expect(response.status).toBe(401);
  });
});
