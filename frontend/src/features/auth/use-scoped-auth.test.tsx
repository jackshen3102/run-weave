import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../services/http";
import { useScopedAuth } from "./use-scoped-auth";

const verifyAuthTokenMock = vi.fn();

vi.mock("../../services/auth", () => ({
  verifyAuthToken: (...args: unknown[]) => verifyAuthTokenMock(...args),
}));

describe("useScopedAuth", () => {
  beforeEach(() => {
    localStorage.clear();
    verifyAuthTokenMock.mockReset();
  });

  it("loads a web token from local storage and updates it locally", async () => {
    localStorage.setItem("viewer.auth.token", "web-token");

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

    result.current.setToken("updated-token");
    await waitFor(() => {
      expect(localStorage.getItem("viewer.auth.token")).toBe("updated-token");
      expect(result.current.token).toBe("updated-token");
    });

    result.current.clearToken();
    await waitFor(() => {
      expect(localStorage.getItem("viewer.auth.token")).toBeNull();
      expect(result.current.token).toBeNull();
      expect(result.current.status).toBe("unauthenticated");
    });
  });

  it("validates an electron-scoped token before authenticating", async () => {
    localStorage.setItem(
      "viewer.auth.connection-auth",
      JSON.stringify({
        "conn-1": {
          token: "scoped-token",
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

  it("removes an invalid electron-scoped token after a 401", async () => {
    localStorage.setItem(
      "viewer.auth.connection-auth",
      JSON.stringify({
        "conn-1": {
          token: "expired-token",
        },
      }),
    );
    verifyAuthTokenMock.mockRejectedValue(
      new HttpError(401, "GET /api/auth/verify failed: 401"),
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
