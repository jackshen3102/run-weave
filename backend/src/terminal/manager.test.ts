import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./manager";
import type {
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
} from "./store";

function createStoreMock() {
  return {
    initialize: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    listSessions: vi.fn(async (): Promise<PersistedTerminalSessionRecord[]> => []),
    getSession: vi.fn(async () => null),
    insertSession: vi.fn(async () => undefined),
    updateSessionName: vi.fn(async () => undefined),
    updateSessionScrollback: vi.fn(async () => undefined),
    updateSessionExit: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } satisfies TerminalSessionStore;
}

describe("TerminalSessionManager", () => {
  it("creates and lists terminal sessions", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);

    const session = await manager.createSession({
      command: "bash",
      args: ["-l"],
      cwd: "/tmp/demo",
      name: "Demo shell",
    });

    expect(session.id).toBeTruthy();
    expect(manager.getSession(session.id)).toEqual(session);
    expect(manager.listSessions()).toHaveLength(1);
    expect(store.insertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/demo",
        scrollback: "",
        status: "running",
      }),
    );
  });

  it("updates exit state", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    const session = await manager.createSession({
      command: "claude",
      args: [],
      cwd: "/tmp/project",
      name: "Claude",
    });

    manager.markExited(session.id, 130);

    expect(store.updateSessionExit).toHaveBeenCalledWith({
      terminalSessionId: session.id,
      status: "exited",
      exitCode: 130,
    });
    expect(manager.getSession(session.id)?.status).toBe("exited");
    expect(manager.getSession(session.id)?.exitCode).toBe(130);
  });

  it("appends output and flushes throttled scrollback snapshots", async () => {
    vi.useFakeTimers();
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    const session = await manager.createSession({
      command: "bash",
      cwd: "/tmp/demo",
    });

    manager.appendOutput(session.id, "hello");
    manager.appendOutput(session.id, " world");

    expect(manager.getScrollback(session.id)).toBe("hello world");
    expect(store.updateSessionScrollback).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(store.updateSessionScrollback).toHaveBeenCalledTimes(1);
    expect(store.updateSessionScrollback).toHaveBeenCalledWith({
      terminalSessionId: session.id,
      scrollback: "hello world",
    });
    vi.useRealTimers();
  });

  it("deletes terminal sessions", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    const session = await manager.createSession({
      command: "codex",
      args: [],
      cwd: "/tmp/project",
      name: "Codex",
    });

    await expect(manager.destroySession(session.id)).resolves.toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(store.deleteSession).toHaveBeenCalledWith(session.id);
  });
});
