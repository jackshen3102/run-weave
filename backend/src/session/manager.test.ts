import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "./manager";

function createBrowserServiceMock() {
  return {
    createSession: vi.fn(async () => ({
      context: { close: vi.fn(async () => undefined) },
      page: { close: vi.fn(async () => undefined) },
    })),
    destroySession: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("SessionManager", () => {
  it("creates and destroys a session", async () => {
    const browserServiceMock = createBrowserServiceMock();
    const manager = new SessionManager(browserServiceMock as never, {
      ttlMs: 60_000,
      cleanupIntervalMs: 60_000,
    });

    const session = await manager.createSession("https://example.com");
    expect(session.id).toBeTruthy();
    expect(manager.getSession(session.id)).toBeDefined();

    const destroyed = await manager.destroySession(session.id);
    expect(destroyed).toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(browserServiceMock.destroySession).toHaveBeenCalledTimes(1);

    await manager.dispose();
  });

  it("keeps session alive during reconnect grace period", async () => {
    vi.useFakeTimers();
    try {
      const browserServiceMock = createBrowserServiceMock();
      const manager = new SessionManager(browserServiceMock as never, {
        ttlMs: 60_000,
        cleanupIntervalMs: 60_000,
        disconnectGraceMs: 500,
      });

      const session = await manager.createSession("https://example.com");
      manager.markConnected(session.id, false);

      vi.advanceTimersByTime(300);
      manager.markConnected(session.id, true);
      vi.advanceTimersByTime(1000);

      expect(manager.getSession(session.id)).toBeDefined();
      expect(browserServiceMock.destroySession).not.toHaveBeenCalled();

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys disconnected session after grace period", async () => {
    vi.useFakeTimers();
    try {
      const browserServiceMock = createBrowserServiceMock();
      const manager = new SessionManager(browserServiceMock as never, {
        ttlMs: 60_000,
        cleanupIntervalMs: 60_000,
        disconnectGraceMs: 200,
      });

      const session = await manager.createSession("https://example.com");
      manager.markConnected(session.id, false);

      vi.advanceTimersByTime(250);
      await Promise.resolve();

      expect(manager.getSession(session.id)).toBeUndefined();
      expect(browserServiceMock.destroySession).toHaveBeenCalledTimes(1);

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
