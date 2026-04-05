import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  changePassword,
  login,
  refreshSession,
  verifyAuthToken,
} from "./auth";

describe("auth service requests", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts web credentials to the login endpoint with cookies enabled", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accessToken: "access-token-1",
        expiresIn: 900,
        sessionId: "session-1",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      login(
        "http://localhost:5001",
        {
          username: "admin",
          password: "secret",
        },
        { clientType: "web" },
      ),
    ).resolves.toEqual({
      accessToken: "access-token-1",
      expiresIn: 900,
      sessionId: "session-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "secret",
        }),
        credentials: "include",
      },
    );
  });

  it("posts electron credentials with connection headers", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accessToken: "access-token-1",
        refreshToken: "refresh-token-1",
        expiresIn: 900,
        sessionId: "session-1",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await login(
      "http://localhost:5001",
      {
        username: "admin",
        password: "secret",
      },
      { clientType: "electron", connectionId: "conn-1" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-auth-client": "electron",
          "x-connection-id": "conn-1",
        },
        body: JSON.stringify({
          username: "admin",
          password: "secret",
        }),
      },
    );
  });

  it("refreshes a web session via cookies", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accessToken: "access-token-2",
        expiresIn: 900,
        sessionId: "session-1",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshSession("http://localhost:5001", { clientType: "web" }),
    ).resolves.toEqual({
      accessToken: "access-token-2",
      expiresIn: 900,
      sessionId: "session-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/auth/refresh",
      {
        method: "POST",
        credentials: "include",
      },
    );
  });

  it("refreshes an electron session from the refresh token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accessToken: "access-token-2",
        refreshToken: "refresh-token-2",
        expiresIn: 900,
        sessionId: "session-1",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshSession("http://localhost:5001", {
      clientType: "electron",
      refreshToken: "refresh-token-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/auth/refresh",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-auth-client": "electron",
        },
        body: JSON.stringify({
          refreshToken: "refresh-token-1",
        }),
      },
    );
  });

  it("verifies a bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ valid: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      verifyAuthToken("http://localhost:5001", "access-token-1"),
    ).resolves.toEqual({ valid: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/auth/verify",
      {
        headers: {
          Authorization: "Bearer access-token-1",
        },
      },
    );
  });

  it("posts password changes with the current bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      changePassword("http://localhost:5001", "access-token-1", {
        oldPassword: "old-secret",
        newPassword: "new-secret",
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/auth/password",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token-1",
        },
        body: JSON.stringify({
          oldPassword: "old-secret",
          newPassword: "new-secret",
        }),
      },
    );
  });
});
