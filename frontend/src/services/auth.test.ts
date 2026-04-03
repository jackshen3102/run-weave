import { beforeEach, describe, expect, it, vi } from "vitest";
import { changePassword, login, verifyAuthToken } from "./auth";

describe("auth service requests", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts credentials to the login endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: "token-1", expiresIn: 300 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      login("http://localhost:5001", {
        username: "admin",
        password: "secret",
      }),
    ).resolves.toEqual({
      token: "token-1",
      expiresIn: 300,
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
      verifyAuthToken("http://localhost:5001", "token-1"),
    ).resolves.toEqual({ valid: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/auth/verify",
      {
        headers: {
          Authorization: "Bearer token-1",
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
      changePassword("http://localhost:5001", "token-1", {
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
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          oldPassword: "old-secret",
          newPassword: "new-secret",
        }),
      },
    );
  });
});
