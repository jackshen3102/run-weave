import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./manager";
import type { PersistedSessionRecord, SessionStore } from "./store";

function createBrowserServiceMock() {
  const profileRoot = path.join(os.tmpdir(), "browser-profiles");
  return {
    createSession: vi.fn(async () => ({
      context: { close: vi.fn(async () => undefined) },
      page: { close: vi.fn(async () => undefined) },
    })),
    restoreSession: vi.fn(async () => ({
      context: { close: vi.fn(async () => undefined) },
      page: { close: vi.fn(async () => undefined) },
    })),
    destroySession: vi.fn(async () => undefined),
    getSessionProfileDir: vi.fn((sessionId: string) =>
      path.join(profileRoot, "sessions", sessionId),
    ),
    stop: vi.fn(async () => undefined),
  };
}

function createSessionStoreMock() {
  return {
    initialize: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    listSessions: vi.fn(async (): Promise<PersistedSessionRecord[]> => []),
    getSession: vi.fn(async () => null),
    insertSession: vi.fn(async () => undefined),
    updateSessionConnection: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } satisfies SessionStore;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("SessionManager", () => {
  it("creates and destroys a session", async () => {
    const browserServiceMock = createBrowserServiceMock();
    const sessionStoreMock = createSessionStoreMock();
    const manager = new SessionManager(
      browserServiceMock as never,
      sessionStoreMock,
    );

    const session = await manager.createSession({
      targetUrl: "https://example.com",
      proxyEnabled: true,
    });
    expect(session.id).toBeTruthy();
    expect(manager.getSession(session.id)).toBeDefined();
    expect(sessionStoreMock.insertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        targetUrl: "https://example.com",
        proxyEnabled: true,
        connected: false,
        profilePath: browserServiceMock.getSessionProfileDir(session.id),
      }),
    );

    const destroyed = await manager.destroySession(session.id);
    expect(destroyed).toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(browserServiceMock.destroySession).toHaveBeenCalledTimes(1);
    expect(sessionStoreMock.deleteSession).toHaveBeenCalledWith(session.id);

    await manager.dispose();
  });

  it("updates persisted connection state when sessions connect", async () => {
    const browserServiceMock = createBrowserServiceMock();
    const sessionStoreMock = createSessionStoreMock();
    const manager = new SessionManager(
      browserServiceMock as never,
      sessionStoreMock,
    );

    const session = await manager.createSession({
      targetUrl: "https://example.com",
      proxyEnabled: true,
    });
    manager.markConnected(session.id, true);

    expect(sessionStoreMock.updateSessionConnection).toHaveBeenCalledWith({
      sessionId: session.id,
      connected: true,
      lastActivityAt: expect.any(String),
    });

    await manager.dispose();
  });

  it("removes the browser profile directory when destroying a session", async () => {
    const browserServiceMock = createBrowserServiceMock();
    const sessionStoreMock = createSessionStoreMock();
    const manager = new SessionManager(
      browserServiceMock as never,
      sessionStoreMock,
    );
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-profile-"));
    tempDirs.push(tempDir);
    browserServiceMock.getSessionProfileDir.mockImplementation(
      (sessionId: string) => path.join(tempDir, "sessions", sessionId),
    );

    const session = await manager.createSession({
      targetUrl: "https://example.com",
      proxyEnabled: true,
    });
    const profilePath = browserServiceMock.getSessionProfileDir(session.id);
    await mkdir(profilePath, { recursive: true });

    await manager.destroySession(session.id);

    await expect(access(profilePath)).rejects.toBeDefined();

    await manager.dispose();
  });

  it("restores persisted sessions as disconnected on initialize", async () => {
    const browserServiceMock = createBrowserServiceMock();
    const sessionStoreMock = createSessionStoreMock();
    sessionStoreMock.listSessions.mockResolvedValue([
      {
        id: "session-1",
        targetUrl: "https://example.com",
        proxyEnabled: true,
        connected: true,
        profilePath: browserServiceMock.getSessionProfileDir("session-1"),
        createdAt: "2026-03-21T00:00:00.000Z",
        lastActivityAt: "2026-03-21T00:01:00.000Z",
      },
    ]);
    const manager = new SessionManager(
      browserServiceMock as never,
      sessionStoreMock,
    );

    await manager.initialize();

    const restoredSession = manager.getSession("session-1");
    expect(restoredSession).toBeDefined();
    expect(restoredSession?.connected).toBe(false);
    expect(restoredSession?.proxyEnabled).toBe(true);
    expect(browserServiceMock.restoreSession).toHaveBeenCalledWith(
      "session-1",
      "https://example.com",
      { proxyEnabled: true },
    );
    expect(sessionStoreMock.updateSessionConnection).toHaveBeenCalledWith({
      sessionId: "session-1",
      connected: false,
      lastActivityAt: "2026-03-21T00:01:00.000Z",
    });

    await manager.dispose();
  });

  it("does not destroy session when disconnected", async () => {
    vi.useFakeTimers();
    try {
      const browserServiceMock = createBrowserServiceMock();
      const sessionStoreMock = createSessionStoreMock();
      const manager = new SessionManager(
        browserServiceMock as never,
        sessionStoreMock,
      );

      const session = await manager.createSession({
        targetUrl: "https://example.com",
        proxyEnabled: false,
      });
      manager.markConnected(session.id, false);

      vi.advanceTimersByTime(5 * 60_000);
      await Promise.resolve();

      expect(manager.getSession(session.id)).toBeDefined();
      expect(browserServiceMock.destroySession).not.toHaveBeenCalled();

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
