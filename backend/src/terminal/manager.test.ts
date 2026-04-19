import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_CLIENT_SCROLLBACK_LINES,
  TERMINAL_LIVE_SCROLLBACK_BYTES,
} from "@browser-viewer/shared";
import { TerminalSessionManager } from "./manager";
import type {
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionMetadataRecord,
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
    listSessions: vi.fn(
      async (): Promise<PersistedTerminalSessionRecord[]> => [],
    ),
    listSessionMetadata: vi.fn(
      async (): Promise<PersistedTerminalSessionMetadataRecord[]> => [],
    ),
    getSession: vi.fn(async () => null),
    readSessionScrollback: vi.fn(async () => ""),
    readSessionLiveScrollback: vi.fn(async () => ""),
    listProjects: vi.fn(
      async (): Promise<PersistedTerminalProjectRecord[]> => [defaultProject],
    ),
    getProject: vi.fn(async () => defaultProject),
    insertProject: vi.fn(async () => undefined),
    updateProject: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
    setDefaultProject: vi.fn(async () => undefined),
    insertSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
    updateSessionRuntimeMetadata: vi.fn(async () => undefined),
    updateSessionLaunch: vi.fn(async () => undefined),
    appendSessionScrollback: vi.fn(async () => undefined),
    updateSessionScrollback: vi.fn(async () => undefined),
    updateSessionExit: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } satisfies TerminalSessionStore;
}

describe("TerminalSessionManager", () => {
  it("initializes restored sessions from metadata without reading scrollback", async () => {
    const store = createStoreMock();
    store.listSessions.mockRejectedValue(
      new Error("full scrollback should not be read on initialize"),
    );
    store.listSessionMetadata.mockResolvedValue([
      {
        id: "terminal-heavy",
        projectId: "project-default",
        name: "heavy shell",
        command: "bash",
        args: ["-l"],
        cwd: "/tmp/heavy",
        status: "running",
        createdAt: "2026-03-29T00:00:00.000Z",
      },
    ]);
    const manager = new TerminalSessionManager(store);

    await manager.initialize();

    expect(store.listSessionMetadata).toHaveBeenCalledTimes(1);
    expect(store.listSessions).not.toHaveBeenCalled();
    expect(store.readSessionScrollback).not.toHaveBeenCalled();
    expect(manager.getSession("terminal-heavy")).toMatchObject({
      id: "terminal-heavy",
      cwd: "/tmp/heavy",
    });
  });

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
      )
        .listProjects()
        .some((project) => project.isDefault),
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

  it("uses the cwd basename as the default session name", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();

    const session = await manager.createSession({
      command: "/bin/zsh",
      args: ["-l"],
      cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
      projectId: "project-default",
    });

    expect(session.name).toBe("feat");
    expect(store.insertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        name: "feat",
        command: "/bin/zsh",
      }),
    );
  });

  it("persists terminal runtime metadata", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();
    const session = await manager.createSession({
      command: "bash",
      cwd: "/tmp/demo",
      projectId: "project-default",
    });

    const updated = await manager.updateRuntimeMetadata(session.id, {
      runtimeKind: "tmux",
      tmuxSessionName: "runweave-terminal-1",
      tmuxSocketPath: "/tmp/runweave/tmux.sock",
      recoverable: true,
    });

    expect(updated).toMatchObject({
      id: session.id,
      runtimeKind: "tmux",
      tmuxSessionName: "runweave-terminal-1",
      tmuxSocketPath: "/tmp/runweave/tmux.sock",
      recoverable: true,
    });
    expect(store.updateSessionRuntimeMetadata).toHaveBeenCalledWith({
      terminalSessionId: session.id,
      runtimeKind: "tmux",
      tmuxSessionName: "runweave-terminal-1",
      tmuxSocketPath: "/tmp/runweave/tmux.sock",
      recoverable: true,
    });
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

  it("appends output and flushes only the pending scrollback chunk", async () => {
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
    expect(store.appendSessionScrollback).not.toHaveBeenCalled();
    expect(store.updateSessionScrollback).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(store.appendSessionScrollback).toHaveBeenCalledTimes(1);
    expect(store.appendSessionScrollback).toHaveBeenCalledWith({
      terminalSessionId: session.id,
      chunk: "hello world",
    });
    expect(store.updateSessionScrollback).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps pending output chunks separate until flush", async () => {
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

    const pendingChunks = (
      manager as unknown as {
        pendingScrollbackChunks: Map<string, string[]>;
      }
    ).pendingScrollbackChunks.get(session.id);
    expect(pendingChunks).toEqual(["hello", " world"]);
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

  it("reads live scrollback from the latest client-visible lines", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();
    const session = await manager.createSession({
      command: "bash",
      cwd: "/tmp/demo",
      projectId: "project-default",
    });
    const scrollback = Array.from(
      { length: TERMINAL_CLIENT_SCROLLBACK_LINES + 20 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");

    manager.appendOutput(session.id, scrollback);

    expect(manager.getLiveScrollback(session.id)).toBe(
      Array.from(
        { length: TERMINAL_CLIENT_SCROLLBACK_LINES },
        (_, index) => `line-${index + 21}`,
      ).join("\n"),
    );
  });

  it("caps live scrollback by bytes after limiting to client-visible lines", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();
    const session = await manager.createSession({
      command: "bash",
      cwd: "/tmp/demo",
      projectId: "project-default",
    });
    const scrollback = `${`${"x".repeat(2_048)}\n`.repeat(
      TERMINAL_CLIENT_SCROLLBACK_LINES,
    )}tail-marker\n`;

    manager.appendOutput(session.id, scrollback);

    const liveScrollback = manager.getLiveScrollback(session.id);
    expect(Buffer.byteLength(liveScrollback, "utf8")).toBeLessThanOrEqual(
      TERMINAL_LIVE_SCROLLBACK_BYTES,
    );
    expect(liveScrollback.endsWith("tail-marker\n")).toBe(true);
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

  it("ignores session metadata with a cwd that no longer exists", async () => {
    const store = createStoreMock();
    const manager = new TerminalSessionManager(store);
    await manager.initialize();
    const session = await manager.createSession({
      command: "zsh",
      cwd: "/Users/bytedance",
      projectId: "project-default",
    });

    const updated = await manager.updateSessionMetadata(session.id, {
      name: "browser-viewer_zsh",
      cwd: "/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer_zsh",
    });

    expect(updated).toMatchObject({
      id: session.id,
      name: "bytedance",
      cwd: "/Users/bytedance",
    });
    expect(store.updateSessionMetadata).not.toHaveBeenCalledWith({
      terminalSessionId: session.id,
      name: "browser-viewer_zsh",
      cwd: "/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer_zsh",
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
      name: "demo",
      command: "/bin/zsh",
      args: ["-l"],
    });
    expect(store.updateSessionLaunch).toHaveBeenCalledWith({
      terminalSessionId: session.id,
      name: "demo",
      command: "/bin/zsh",
      args: ["-l"],
    });
  });
});
