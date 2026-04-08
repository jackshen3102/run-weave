import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./manager";
import type {
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
} from "./store";

function createStoreMock() {
  const defaultProject: PersistedTerminalProjectRecord = {
    id: "project-default",
    name: "Default Project",
    createdAt: "2026-03-29T00:00:00.000Z",
    isDefault: true,
  };
  return {
    initialize: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    listSessions: vi.fn(async (): Promise<PersistedTerminalSessionRecord[]> => []),
    getSession: vi.fn(async () => null),
    listProjects: vi.fn(async (): Promise<PersistedTerminalProjectRecord[]> => [
      defaultProject,
    ]),
    getProject: vi.fn(async () => defaultProject),
    insertProject: vi.fn(async () => undefined),
    updateProject: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
    setDefaultProject: vi.fn(async () => undefined),
    insertSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
    updateSessionLaunch: vi.fn(async () => undefined),
    updateSessionScrollback: vi.fn(async () => undefined),
    updateSessionExit: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } satisfies TerminalSessionStore;
}

describe("TerminalSessionManager", () => {
  it("initializes with a default project and creates sessions inside it", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);

    await manager.initialize();

    const projects = await (
      manager as unknown as {
        listProjects: () => Array<{ id: string; isDefault: boolean }>;
      }
    ).listProjects();
    const session = await manager.createSession({
      command: "bash",
      cwd: "/tmp/demo",
      projectId: projects[0]?.id,
    });

    expect(projects).toEqual([
      expect.objectContaining({
        isDefault: true,
      }),
    ]);
    expect(store.insertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        projectId: projects[0]?.id,
      }),
    );
  });

  it("cascades terminal sessions when deleting a project and keeps a default project", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);

    await manager.initialize();

    const createdProject = await (
      manager as unknown as {
        createProject: (name: string) => Promise<{ id: string }>;
      }
    ).createProject("browser-viewer");

    const session = await manager.createSession({
      command: "bash",
      cwd: "/tmp/demo",
      projectId: createdProject.id,
    });

    await (
      manager as unknown as {
        deleteProject: (projectId: string) => Promise<boolean>;
      }
    ).deleteProject(createdProject.id);

    expect(manager.getSession(session.id)).toBeUndefined();
    expect(store.deleteSession).toHaveBeenCalledWith(session.id);
    expect(
      (
        manager as unknown as {
          listProjects: () => Array<{ isDefault: boolean }>;
        }
      ).listProjects().some((project) => project.isDefault),
    ).toBe(true);
  });

  it("creates and lists terminal sessions", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();

    const session = await manager.createSession({
      command: "bash",
      args: ["-l"],
      cwd: "/tmp/demo",
      name: "Demo shell",
      projectId: "project-default",
    });

    expect(session.id).toBeTruthy();
    expect(manager.getSession(session.id)).toEqual(session);
    expect(manager.listSessions()).toHaveLength(1);
    expect(store.insertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        projectId: "project-default",
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
    await manager.initialize();
    const session = await manager.createSession({
      command: "claude",
      args: [],
      cwd: "/tmp/project",
      name: "Claude",
      projectId: "project-default",
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
    await manager.initialize();
    const session = await manager.createSession({
      command: "bash",
      cwd: "/tmp/demo",
      projectId: "project-default",
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

  it("retains long scrollback transcripts instead of trimming after a few hundred kilobytes", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();
    const session = await manager.createSession({
      command: "bash",
      cwd: "/tmp/demo",
      projectId: "project-default",
    });
    const largeTranscript = `${"line-1234567890\n".repeat(20_000)}done\n`;

    manager.appendOutput(session.id, largeTranscript);

    expect(manager.getScrollback(session.id)).toBe(largeTranscript);
  });

  it("deletes terminal sessions", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();
    const session = await manager.createSession({
      command: "codex",
      args: [],
      cwd: "/tmp/project",
      name: "Codex",
      projectId: "project-default",
    });

    await expect(manager.destroySession(session.id)).resolves.toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(store.deleteSession).toHaveBeenCalledWith(session.id);
  });

  it("updates session metadata and persists the latest cwd", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();
    const session = await manager.createSession({
      command: "zsh",
      cwd: "/Users/bytedance",
      projectId: "project-default",
    });

    const updated = await manager.updateSessionMetadata(session.id, {
      name: "browser-hub",
      cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
    });

    expect(updated).toMatchObject({
      id: session.id,
      name: "browser-hub",
      cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
    });
    expect(store.updateSessionMetadata).toHaveBeenCalledWith({
      terminalSessionId: session.id,
      name: "browser-hub",
      cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
    });
  });

  it("updates session launch config and renames command-derived tabs", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();
    const session = await manager.createSession({
      command: "/bad-shell",
      args: ["--broken"],
      cwd: "/tmp/demo",
      projectId: "project-default",
    });

    const updated = await manager.updateSessionLaunch(session.id, {
      command: "/bin/zsh",
      args: ["-l"],
    });

    expect(updated).toMatchObject({
      id: session.id,
      name: "/bin/zsh",
      command: "/bin/zsh",
      args: ["-l"],
    });
    expect(store.updateSessionLaunch).toHaveBeenCalledWith({
      terminalSessionId: session.id,
      name: "/bin/zsh",
      command: "/bin/zsh",
      args: ["-l"],
    });
  });
});
