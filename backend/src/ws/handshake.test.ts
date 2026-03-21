import { describe, expect, it, vi } from "vitest";
import { validateWebSocketHandshake } from "./handshake";

describe("validateWebSocketHandshake", () => {
  it("rejects unauthorized token", () => {
    const result = validateWebSocketHandshake({
      request: { url: "/ws?sessionId=s-1" } as never,
      authService: { verifyToken: vi.fn(() => false) } as never,
      sessionManager: { getSession: vi.fn() } as never,
    });

    expect(result).toMatchObject({
      ok: false,
      errorMessage: "Unauthorized",
      closeReason: "Unauthorized",
    });
  });

  it("rejects missing sessionId", () => {
    const result = validateWebSocketHandshake({
      request: { url: "/ws?token=ok" } as never,
      authService: { verifyToken: vi.fn(() => true) } as never,
      sessionManager: { getSession: vi.fn() } as never,
    });

    expect(result).toMatchObject({
      ok: false,
      errorMessage: "Missing sessionId",
      closeReason: "Missing sessionId",
    });
  });

  it("rejects missing session", () => {
    const result = validateWebSocketHandshake({
      request: { url: "/ws?token=ok&sessionId=s-404" } as never,
      authService: { verifyToken: vi.fn(() => true) } as never,
      sessionManager: { getSession: vi.fn(() => undefined) } as never,
    });

    expect(result).toMatchObject({
      ok: false,
      errorMessage: "Session not found",
      closeReason: "Session not found",
      logMeta: { sessionId: "s-404" },
    });
  });

  it("returns session on success", () => {
    const session = { id: "s-1", browserSession: { page: {}, context: {} } };
    const result = validateWebSocketHandshake({
      request: { url: "/ws?token=ok&sessionId=s-1" } as never,
      authService: { verifyToken: vi.fn(() => true) } as never,
      sessionManager: { getSession: vi.fn(() => session) } as never,
    });

    expect(result).toEqual({ ok: true, sessionId: "s-1", session, tabId: null });
  });

  it("rejects missing tabId when required", () => {
    const session = { id: "s-1", browserSession: { page: {}, context: {} } };
    const result = validateWebSocketHandshake({
      request: { url: "/ws/devtools-proxy?token=ok&sessionId=s-1" } as never,
      authService: { verifyToken: vi.fn(() => true) } as never,
      sessionManager: { getSession: vi.fn(() => session) } as never,
      requireTabId: true,
    });

    expect(result).toMatchObject({
      ok: false,
      errorMessage: "Missing tabId",
      closeReason: "Missing tabId",
    });
  });
});
