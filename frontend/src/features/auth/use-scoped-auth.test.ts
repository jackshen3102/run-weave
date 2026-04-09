import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScopedAuth } from "./use-scoped-auth";

const { refreshSessionMock, verifyAuthTokenMock } = vi.hoisted(() => ({
  refreshSessionMock: vi.fn(),
  verifyAuthTokenMock: vi.fn(),
}));

vi.mock("../../services/auth", () => ({
  refreshSession: refreshSessionMock,
  verifyAuthToken: verifyAuthTokenMock,
}));

interface HookResult {
  token: string | null;
  status: "checking" | "authenticated" | "unauthenticated";
  setSession: (session: {
    accessToken: string;
    expiresIn: number;
    sessionId: string;
    refreshToken?: string;
  }) => void;
  clearSession: () => void;
  setToken: (nextToken: string) => void;
  clearToken: () => void;
}

function flushEffects(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
  });
}

describe("useScopedAuth", () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentResult: HookResult | null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    refreshSessionMock.mockReset();
    verifyAuthTokenMock.mockReset();
    // Tell React's act() helpers they are running in a supported test env.
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    currentResult = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("refreshes an expired web session when the app returns to the foreground", async () => {
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    localStorage.setItem(
      "viewer.auth.token",
      JSON.stringify({
        accessToken: "access-token-1",
        accessExpiresAt: Date.now() + 5 * 60 * 1000,
        sessionId: "session-1",
      }),
    );
    refreshSessionMock.mockResolvedValue({
      accessToken: "access-token-2",
      expiresIn: 900,
      sessionId: "session-2",
    });

    function HookHarness() {
      currentResult = useScopedAuth({
        apiBase: "http://localhost:5001",
        isElectron: false,
        connectionId: null,
        webStorageKey: "viewer.auth.token",
      });
      return null;
    }

    await act(async () => {
      root.render(createElement(HookHarness));
    });
    await flushEffects();

    expect(currentResult?.status).toBe("authenticated");
    expect(currentResult?.token).toBe("access-token-1");
    expect(refreshSessionMock).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-04-10T00:06:00.000Z"));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flushEffects();

    expect(refreshSessionMock).toHaveBeenCalledWith("http://localhost:5001", {
      clientType: "web",
    });
    expect(currentResult?.status).toBe("authenticated");
    expect(currentResult?.token).toBe("access-token-2");
    expect(JSON.parse(localStorage.getItem("viewer.auth.token") ?? "null")).toMatchObject({
      accessToken: "access-token-2",
      sessionId: "session-2",
    });
  });
});
