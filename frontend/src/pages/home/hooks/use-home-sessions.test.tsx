import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeSessions } from "./use-home-sessions";

const fetchBrowserSessionListMock = vi.fn();
const getDefaultCdpEndpointMock = vi.fn();
const createBrowserSessionMock = vi.fn();
const deleteBrowserSessionMock = vi.fn();
const updateBrowserSessionMock = vi.fn();

vi.mock("../../../services/session", () => ({
  listSessions: (...args: unknown[]) => fetchBrowserSessionListMock(...args),
  getDefaultCdpEndpoint: (...args: unknown[]) =>
    getDefaultCdpEndpointMock(...args),
  createSession: (...args: unknown[]) => createBrowserSessionMock(...args),
  deleteSession: (...args: unknown[]) => deleteBrowserSessionMock(...args),
  updateSession: (...args: unknown[]) => updateBrowserSessionMock(...args),
}));

describe("useHomeSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads sessions and the default cdp endpoint on mount", async () => {
    fetchBrowserSessionListMock.mockResolvedValue([
      {
        sessionId: "session-1",
        name: "Session 1",
        lastActivityAt: "2026-04-04T10:00:00.000Z",
      },
    ]);
    getDefaultCdpEndpointMock.mockResolvedValue({
      endpoint: "http://127.0.0.1:9333",
    });

    const onAuthExpired = vi.fn();
    const onEnterSession = vi.fn();

    const { result } = renderHook(() =>
      useHomeSessions({
        apiBase: "http://localhost:5001",
        token: "token-1",
        onAuthExpired,
        onEnterSession,
      }),
    );

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    expect(result.current.defaultCdpEndpoint).toBe("http://127.0.0.1:9333");
    expect(result.current.cdpEndpoint).toBe("http://127.0.0.1:9333");
  });

  it("creates a browser session and enters it after reloading the list", async () => {
    fetchBrowserSessionListMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          sessionId: "session-2",
          name: "Created Session",
          lastActivityAt: "2026-04-04T11:00:00.000Z",
        },
      ]);
    getDefaultCdpEndpointMock.mockResolvedValue({
      endpoint: "http://127.0.0.1:9222",
    });
    createBrowserSessionMock.mockResolvedValue({
      sessionId: "session-2",
    });
    const onAuthExpired = vi.fn();
    const onEnterSession = vi.fn();

    const { result } = renderHook(() =>
      useHomeSessions({
        apiBase: "http://localhost:5001",
        token: "token-1",
        onAuthExpired,
        onEnterSession,
      }),
    );

    await waitFor(() => {
      expect(fetchBrowserSessionListMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.setSessionName("Created Session");
    });

    await act(async () => {
      await result.current.createSession();
    });

    expect(createBrowserSessionMock).toHaveBeenCalledWith(
      "http://localhost:5001",
      {
        name: "Created Session",
        source: {
          type: "connect-cdp",
          endpoint: "http://127.0.0.1:9222",
        },
      },
      "token-1",
    );
    expect(onEnterSession).toHaveBeenCalledWith("session-2");
    expect(result.current.sessions).toHaveLength(1);
  });
});
