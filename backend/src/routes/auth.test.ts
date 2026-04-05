import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRouter } from "./auth";

function createTestServer() {
  const authService = {
    login: vi.fn(async (username: string, password: string, params: unknown) => {
      if (username !== "admin" || password !== "secret") {
        return null;
      }

      if ((params as { clientType?: string }).clientType === "web") {
        return {
          accessToken: "access-token-abc",
          refreshToken: "refresh-token-abc",
          expiresIn: 900,
          sessionId: "session-web-1",
        };
      }

      return {
        accessToken: "access-token-abc",
        refreshToken: "refresh-token-abc",
        expiresIn: 900,
        sessionId: "session-electron-1",
      };
    }),
    verifyAccessToken: vi.fn((token: string) =>
      token === "access-token-abc" ? { sessionId: "session-web-1" } : null,
    ),
    refreshSession: vi.fn(async (refreshToken: string) => {
      if (refreshToken !== "refresh-token-abc") {
        return null;
      }
      return {
        accessToken: "access-token-next",
        refreshToken: "refresh-token-next",
        expiresIn: 900,
        sessionId: "session-web-1",
      };
    }),
    logoutSession: vi.fn(async (accessToken: string) => {
      return accessToken === "access-token-abc";
    }),
    changePassword: vi.fn(
      async (accessToken: string, oldPassword: string, newPassword: string) => {
        return (
          accessToken === "access-token-abc" &&
          oldPassword === "secret" &&
          newPassword.length > 0
        );
      },
    ),
  };

  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter(authService as never, {
    refreshCookieName: "viewer_refresh",
    secureCookies: false,
  }));
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

  it("returns access token and sets a refresh cookie for web login", async () => {
    const { server, authService } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      accessToken: string;
      expiresIn: number;
      sessionId: string;
      refreshToken?: string;
    };
    expect(payload).toEqual({
      accessToken: "access-token-abc",
      expiresIn: 900,
      sessionId: "session-web-1",
    });
    expect(response.headers.get("set-cookie")).toContain("viewer_refresh=refresh-token-abc");
    expect(authService.login).toHaveBeenCalledWith("admin", "secret", {
      clientType: "web",
      connectionId: undefined,
    });
  });

  it("returns refresh token in the response for electron login", async () => {
    const { server, authService } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-auth-client": "electron",
        "x-connection-id": "conn-2",
      },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accessToken: "access-token-abc",
      refreshToken: "refresh-token-abc",
      expiresIn: 900,
      sessionId: "session-electron-1",
    });
    expect(authService.login).toHaveBeenCalledWith("admin", "secret", {
      clientType: "electron",
      connectionId: "conn-2",
    });
  });

  it("refreshes a web session from the refresh cookie", async () => {
    const { server, authService } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: "POST",
      headers: {
        Cookie: "viewer_refresh=refresh-token-abc",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accessToken: "access-token-next",
      expiresIn: 900,
      sessionId: "session-web-1",
    });
    expect(response.headers.get("set-cookie")).toContain("viewer_refresh=refresh-token-next");
    expect(authService.refreshSession).toHaveBeenCalledWith("refresh-token-abc");
  });

  it("refreshes an electron session from the request body", async () => {
    const { server, authService } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-auth-client": "electron",
      },
      body: JSON.stringify({ refreshToken: "refresh-token-abc" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accessToken: "access-token-next",
      refreshToken: "refresh-token-next",
      expiresIn: 900,
      sessionId: "session-web-1",
    });
    expect(authService.refreshSession).toHaveBeenCalledWith("refresh-token-abc");
  });

  it("verifies a valid bearer access token", async () => {
    const { server, authService } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/verify`, {
      headers: { Authorization: "Bearer access-token-abc" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });
    expect(authService.verifyAccessToken).toHaveBeenCalledWith("access-token-abc");
  });

  it("logs out the current session and clears the refresh cookie", async () => {
    const { server, authService } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: "Bearer access-token-abc",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("viewer_refresh=;");
    expect(authService.logoutSession).toHaveBeenCalledWith("access-token-abc");
  });

  it("changes password for the authenticated current session", async () => {
    const { server, authService } = createTestServer();
    servers.push(server);
    const port = await startServer(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/auth/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer access-token-abc",
      },
      body: JSON.stringify({
        oldPassword: "secret",
        newPassword: "new-secret",
      }),
    });

    expect(response.status).toBe(204);
    expect(authService.changePassword).toHaveBeenCalledWith(
      "access-token-abc",
      "secret",
      "new-secret",
    );
  });
});
