import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxLifecycleCoordinator } from "./tmux-lifecycle-coordinator";
import { TmuxOutputWatcher } from "./tmux-output-watcher";

describe("TmuxOutputWatcher", () => {
  const watchers: TmuxOutputWatcher[] = [];

  afterEach(async () => {
    for (const watcher of watchers) {
      await watcher.dispose();
    }
    watchers.length = 0;
  });

  it("records future tmux pane output through the terminal recorder", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "runweave-tmux-output-"),
    );
    const session = {
      id: "terminal-1",
      command: "bash",
      args: [],
      cwd: outputDir,
      activeCommand: null,
      runtimeKind: "tmux" as const,
      status: "running" as const,
      tmuxSessionName: "runweave-terminal-1",
      tmuxSocketPath: "/tmp/runweave/tmux.sock",
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => session),
      listSessions: vi.fn(() => [session]),
      appendOutput: vi.fn(),
      updateSessionMetadata: vi.fn(async () => session),
      markExited: vi.fn(),
    };
    const tmuxService = {
      socketPath: "/tmp/runweave/tmux.sock",
      buildSessionName: vi.fn(() => "runweave-terminal-1"),
      pipePaneOutput: vi.fn(async () => undefined),
      readPaneMetadata: vi.fn(async () => ({
        cwd: outputDir,
        activeCommand: null,
      })),
      stopPaneOutputPipe: vi.fn(async () => undefined),
    };
    const watcher = new TmuxOutputWatcher({
      outputDir,
      terminalSessionManager: terminalSessionManager as never,
      tmuxService: tmuxService as never,
      pollIntervalMs: 10,
    });
    watchers.push(watcher);

    await watcher.watchSession(session as never);
    await writeFile(path.join(outputDir, "terminal-1.log"), "hello\n", "utf8");

    await vi.waitFor(() => {
      expect(terminalSessionManager.appendOutput).toHaveBeenCalledWith(
        "terminal-1",
        "hello\n",
      );
    });
    await vi.waitFor(async () => {
      await expect(
        stat(path.join(outputDir, "terminal-1.log")),
      ).resolves.toEqual(expect.objectContaining({ size: 0 }));
    });
    expect(tmuxService.pipePaneOutput).toHaveBeenCalledWith(
      {
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      },
      path.join(outputDir, "terminal-1.log"),
    );

    await watcher.watchSession(session as never);
    expect(tmuxService.pipePaneOutput).toHaveBeenCalledTimes(1);

    await watcher.dispose();
    expect(tmuxService.stopPaneOutputPipe).toHaveBeenCalledWith({
      sessionName: "runweave-terminal-1",
      socketPath: "/tmp/runweave/tmux.sock",
    });
  });

  it("marks non-interactive tmux command sessions exited when pane metadata disappears", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "runweave-tmux-output-"),
    );
    const session = {
      id: "terminal-1",
      command: "/bin/sleep",
      args: ["2"],
      cwd: outputDir,
      activeCommand: "sleep",
      runtimeKind: "tmux" as const,
      status: "running" as const,
      tmuxSessionName: "runweave-terminal-1",
      tmuxSocketPath: "/tmp/runweave/tmux.sock",
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => session),
      listSessions: vi.fn(() => [session]),
      appendOutput: vi.fn(),
      updateSessionMetadata: vi.fn(async () => ({
        ...session,
        activeCommand: null,
      })),
      markExited: vi.fn(),
    };
    const tmuxService = {
      socketPath: "/tmp/runweave/tmux.sock",
      buildSessionName: vi.fn(() => "runweave-terminal-1"),
      pipePaneOutput: vi.fn(async () => undefined),
      readPaneMetadata: vi.fn(async () => null),
      stopPaneOutputPipe: vi.fn(async () => undefined),
    };
    const watcher = new TmuxOutputWatcher({
      outputDir,
      terminalSessionManager: terminalSessionManager as never,
      tmuxService: tmuxService as never,
      pollIntervalMs: 10,
    });
    watchers.push(watcher);

    await watcher.watchSession(session as never);

    await vi.waitFor(() => {
      expect(terminalSessionManager.updateSessionMetadata).toHaveBeenCalledWith(
        "terminal-1",
        {
          cwd: outputDir,
          activeCommand: null,
        },
      );
      expect(terminalSessionManager.markExited).toHaveBeenCalledWith(
        "terminal-1",
      );
    });
    expect(tmuxService.stopPaneOutputPipe).toHaveBeenCalledWith({
      sessionName: "runweave-terminal-1",
      socketPath: "/tmp/runweave/tmux.sock",
    });
  });

  it("defers non-interactive tmux command exit while a websocket client is attached", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "runweave-tmux-output-"),
    );
    const session = {
      id: "terminal-1",
      command: "/bin/sleep",
      args: ["2"],
      cwd: outputDir,
      activeCommand: "sleep",
      runtimeKind: "tmux" as const,
      status: "running" as const,
      tmuxSessionName: "runweave-terminal-1",
      tmuxSocketPath: "/tmp/runweave/tmux.sock",
    };
    const terminalSessionManager = {
      getSession: vi.fn(() => session),
      listSessions: vi.fn(() => [session]),
      appendOutput: vi.fn(),
      updateSessionMetadata: vi.fn(async () => ({
        ...session,
        activeCommand: null,
      })),
      markExited: vi.fn(),
    };
    const tmuxService = {
      socketPath: "/tmp/runweave/tmux.sock",
      buildSessionName: vi.fn(() => "runweave-terminal-1"),
      pipePaneOutput: vi.fn(async () => undefined),
      readPaneMetadata: vi.fn(async () => null),
      stopPaneOutputPipe: vi.fn(async () => undefined),
    };
    const tmuxLifecycleCoordinator = new TmuxLifecycleCoordinator();
    const releaseClient =
      tmuxLifecycleCoordinator.registerAttachedClient("terminal-1");
    const watcher = new TmuxOutputWatcher({
      outputDir,
      terminalSessionManager: terminalSessionManager as never,
      tmuxService: tmuxService as never,
      tmuxLifecycleCoordinator,
      pollIntervalMs: 10,
    });
    watchers.push(watcher);

    await watcher.watchSession(session as never);

    await vi.waitFor(() => {
      expect(terminalSessionManager.updateSessionMetadata).toHaveBeenCalledWith(
        "terminal-1",
        {
          cwd: outputDir,
          activeCommand: null,
        },
      );
      expect(tmuxService.stopPaneOutputPipe).toHaveBeenCalledWith({
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave/tmux.sock",
      });
    });
    expect(terminalSessionManager.markExited).not.toHaveBeenCalled();
    releaseClient();
  });
});
