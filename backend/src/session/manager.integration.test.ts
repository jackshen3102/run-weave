import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./manager";
import { SQLiteSessionStore } from "./sqlite-store";

const tempDirs: string[] = [];

function createBrowserServiceMock(profileRootDir: string) {
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
    getRemoteDebuggingPort: vi.fn(() => null),
    getSessionProfileDir: vi.fn((sessionId: string) =>
      path.join(profileRootDir, "sessions", sessionId),
    ),
    isDevtoolsEnabled: vi.fn(() => false),
    stop: vi.fn(async () => undefined),
  };
}

async function createTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-manager-int-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("SessionManager integration", () => {
  it("restores SQLite-backed sessions across a restart", async () => {
    const tempDir = await createTempDir();
    const databaseFile = path.join(tempDir, "session-store.db");
    const profileRootDir = path.join(tempDir, ".browser-profile");

    const firstBrowserService = createBrowserServiceMock(profileRootDir);
    const firstStore = new SQLiteSessionStore(databaseFile);
    const firstManager = new SessionManager(
      firstBrowserService as never,
      firstStore,
    );
    await firstManager.initialize();

    const createdSession = await firstManager.createSession({
      targetUrl: "https://example.com",
      source: {
        type: "launch",
        proxyEnabled: true,
      },
    });
    firstManager.markConnected(createdSession.id, true);
    await firstManager.dispose();

    const secondBrowserService = createBrowserServiceMock(profileRootDir);
    const secondStore = new SQLiteSessionStore(databaseFile);
    const secondManager = new SessionManager(
      secondBrowserService as never,
      secondStore,
    );
    await secondManager.initialize();

    const restoredSession = secondManager.getSession(createdSession.id);
    expect(restoredSession).toBeDefined();
    expect(restoredSession?.targetUrl).toBe("https://example.com");
    expect(restoredSession?.connected).toBe(false);
    expect(restoredSession?.proxyEnabled).toBe(true);
    expect(secondBrowserService.restoreSession).toHaveBeenCalledWith(
      createdSession.id,
      "https://example.com",
      {
        type: "launch",
        profilePath: path.join(profileRootDir, "sessions", createdSession.id),
        proxyEnabled: true,
        headers: {},
      },
    );
    await expect(secondStore.getSession(createdSession.id)).resolves.toEqual(
      expect.objectContaining({
        id: createdSession.id,
        connected: false,
        proxyEnabled: true,
        profilePath: path.join(profileRootDir, "sessions", createdSession.id),
        profileMode: "managed",
        headers: {},
      }),
    );

    await secondManager.dispose();
  });

  it("keeps persisted sessions in SQLite when restore fails during restart", async () => {
    const tempDir = await createTempDir();
    const databaseFile = path.join(tempDir, "session-store.db");
    const profileRootDir = path.join(tempDir, ".browser-profile");

    const firstBrowserService = createBrowserServiceMock(profileRootDir);
    const firstStore = new SQLiteSessionStore(databaseFile);
    const firstManager = new SessionManager(
      firstBrowserService as never,
      firstStore,
    );
    await firstManager.initialize();

    const createdSession = await firstManager.createSession({
      targetUrl: "https://example.com",
      source: {
        type: "launch",
      },
    });
    await firstManager.dispose();

    const restoreError = new Error("restore failed");
    const secondBrowserService = createBrowserServiceMock(profileRootDir);
    secondBrowserService.restoreSession.mockRejectedValueOnce(restoreError);
    const secondStore = new SQLiteSessionStore(databaseFile);
    const secondManager = new SessionManager(
      secondBrowserService as never,
      secondStore,
    );

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await secondManager.initialize();

    expect(secondManager.getSession(createdSession.id)).toBeUndefined();
    await expect(secondStore.getSession(createdSession.id)).resolves.toEqual(
      expect.objectContaining({
        id: createdSession.id,
        targetUrl: "https://example.com",
      }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[viewer-be] failed to restore session",
      expect.objectContaining({
        sessionId: createdSession.id,
        error: String(restoreError),
      }),
    );

    consoleErrorSpy.mockRestore();
    await secondManager.dispose();
  });
});
