import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../services/http";
import { useScopedAuth } from "./use-scoped-auth";

const refreshSessionMock = vi.fn();
const verifyAuthTokenMock = vi.fn();

vi.mock("../../services/auth", () => ({
  verifyAuthToken: (...args: unknown[]) => verifyAuthTokenMock(...args),
  refreshSession: (...args: unknown[]) => refreshSessionMock(...args),
}));

describe("useScopedAuth", () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    refreshSessionMock.mockReset();
    verifyAuthTokenMock.mockReset();
  });

  it("loads a web session from local storage and updates it locally", async () => {
    localStorage.setItem(
      "viewer.auth.token",
      JSON.stringify({
        accessToken: "web-token",
        accessExpiresAt: Date.now() + 120_000,
        sessionId: "session-1",
      }),
    );

    const { result } = renderHook(() =>
      useScopedAuth({
        apiBase: "/api",
        isElectron: false,
        connectionId: null,
        webStorageKey: "viewer.auth.token",
      }),
    );

    expect(result.current.token).toBe("web-token");
    expect(result.current.status).toBe("authenticated");

    result.current.setSession({
      accessToken: "updated-token",
      expiresIn: 900,
      sessionId: "session-2",
    });
    await waitFor(() => {
      expect(result.current.token).toBe("updated-token");
    });

    expect(
      JSON.parse(localStorage.getItem("viewer.auth.token") ?? "null"),
    ).toMatchObject({
      accessToken: "updated-token",
      sessionId: "session-2",
    });

    result.current.clearSession();
    await waitFor(() => {
      expect(localStorage.getItem("viewer.auth.token")).toBeNull();
      expect(result.current.token).toBeNull();
      expect(result.current.status).toBe("unauthenticated");
    });
  });

  it("refreshes a web session from cookies when the stored access token is expired", async () => {
    localStorage.setItem(
      "viewer.auth.token",
      JSON.stringify({
        accessToken: "expired-token",
        accessExpiresAt: Date.now() - 1_000,
        sessionId: "session-1",
      }),
    );
    refreshSessionMock.mockResolvedValue({
      accessToken: "fresh-token",
      expiresIn: 900,
      sessionId: "session-2",
    });

    const { result } = renderHook(() =>
      useScopedAuth({
        apiBase: "http://localhost:5001",
        isElectron: false,
        connectionId: null,
        webStorageKey: "viewer.auth.token",
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("authenticated");
    });
    expect(result.current.token).toBe("fresh-token");
    expect(refreshSessionMock).toHaveBeenCalledWith("http://localhost:5001", {
      clientType: "web",
    });
  });

  it("validates an electron-scoped token before authenticating", async () => {
    localStorage.setItem(
      "viewer.auth.connection-auth",
      JSON.stringify({
        "conn-1": {
          accessToken: "scoped-token",
          accessExpiresAt: Date.now() + 120_000,
          refreshToken: "refresh-token",
          sessionId: "session-1",
        },
      }),
    );
    verifyAuthTokenMock.mockResolvedValue({ valid: true });

    const { result } = renderHook(() =>
      useScopedAuth({
        apiBase: "http://localhost:5001",
        isElectron: true,
        connectionId: "conn-1",
        webStorageKey: "viewer.auth.token",
      }),
    );

    expect(result.current.token).toBe("scoped-token");
    expect(result.current.status).toBe("checking");

    await waitFor(() => {
      expect(result.current.status).toBe("authenticated");
    });
    expect(verifyAuthTokenMock).toHaveBeenCalledWith(
      "http://localhost:5001",
      "scoped-token",
    );
  });

  it("refreshes an expired electron-scoped session with its refresh token", async () => {
    localStorage.setItem(
      "viewer.auth.connection-auth",
      JSON.stringify({
        "conn-1": {
          accessToken: "expired-token",
          accessExpiresAt: Date.now() - 1_000,
          refreshToken: "refresh-token",
          sessionId: "session-1",
        },
      }),
    );
    refreshSessionMock.mockResolvedValue({
      accessToken: "fresh-token",
      refreshToken: "refresh-token-next",
      expiresIn: 900,
      sessionId: "session-2",
    });

    const { result } = renderHook(() =>
      useScopedAuth({
        apiBase: "http://localhost:5001",
        isElectron: true,
        connectionId: "conn-1",
        webStorageKey: "viewer.auth.token",
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("authenticated");
    });
    expect(result.current.token).toBe("fresh-token");
    expect(refreshSessionMock).toHaveBeenCalledWith("http://localhost:5001", {
      clientType: "electron",
      refreshToken: "refresh-token",
    });
  });

  it("refreshes an electron-scoped session before the access token expires while the app stays open", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "viewer.auth.connection-auth",
      JSON.stringify({
        "conn-1": {
          accessToken: "scoped-token",
          accessExpiresAt: Date.now() + 30_000,
          refreshToken: "refresh-token",
          sessionId: "session-1",
        },
      }),
    );
    verifyAuthTokenMock.mockResolvedValue({ valid: true });
    refreshSessionMock.mockResolvedValue({
      accessToken: "fresh-token",
      refreshToken: "refresh-token-next",
      expiresIn: 900,
      sessionId: "session-2",
    });

    const { result } = renderHook(() =>
      useScopedAuth({
        apiBase: "http://localhost:5001",
        isElectron: true,
        connectionId: "conn-1",
        webStorageKey: "viewer.auth.token",
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("authenticated");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(refreshSessionMock).toHaveBeenCalledWith("http://localhost:5001", {
      clientType: "electron",
      refreshToken: "refresh-token",
    });
    expect(result.current.token).toBe("fresh-token");
    expect(
      JSON.parse(localStorage.getItem("viewer.auth.connection-auth") ?? "null"),
    ).toMatchObject({
      "conn-1": {
        accessToken: "fresh-token",
        refreshToken: "refresh-token-next",
        sessionId: "session-2",
      },
    });
  });

  it("removes an invalid electron-scoped session after refresh fails", async () => {
    localStorage.setItem(
      "viewer.auth.connection-auth",
      JSON.stringify({
        "conn-1": {
          accessToken: "expired-token",
          accessExpiresAt: Date.now() - 1_000,
          refreshToken: "refresh-token",
          sessionId: "session-1",
        },
      }),
    );
    refreshSessionMock.mockRejectedValue(
      new HttpError(401, "POST /api/auth/refresh failed: 401"),
    );

    const { result } = renderHook(() =>
      useScopedAuth({
        apiBase: "http://localhost:5001",
        isElectron: true,
        connectionId: "conn-1",
        webStorageKey: "viewer.auth.token",
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("unauthenticated");
    });
    expect(result.current.token).toBeNull();
    expect(localStorage.getItem("viewer.auth.connection-auth")).toBe("{}");
  });
});
