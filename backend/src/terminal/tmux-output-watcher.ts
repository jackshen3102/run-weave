import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../logging";
import { createTerminalRuntimeRecorder } from "./runtime-recorder";
import {
  captureScrollbackBufferCursor,
  createScrollbackBuffer,
} from "./scrollback-buffer";
import type { TerminalSessionManager, TerminalSessionRecord } from "./manager";
import type { TmuxPaneTarget, TmuxService } from "./tmux-service";
import type { TmuxLifecycleCoordinator } from "./tmux-lifecycle-coordinator";
import {
  findScrollbackBufferPositionAfterMarker,
  isInteractiveShellLaunch,
  isSamePaneTarget,
  isSameTmuxSessionTarget,
  readScrollbackBufferFromPosition,
  resolvePaneWatcherKey,
  resolveTmuxTarget,
  sanitizeOutputPathSegment,
  shouldWatchSession,
  type WatchedTmuxPane,
  waitForPaneOutputBoundary,
} from "./tmux-output-watcher-helpers";
import { TmuxOutputPoller } from "./tmux-output-poller";

interface TmuxOutputWatcherOptions {
  outputDir: string;
  terminalSessionManager: TerminalSessionManager;
  tmuxService: TmuxService;
  tmuxLifecycleCoordinator?: TmuxLifecycleCoordinator;
  pollIntervalMs?: number;
  maxTransportBytes?: number;
  startupMaxSessions?: number;
  startupConcurrency?: number;
}

export interface TmuxPaneOutputCursor {
  terminalSessionId: string;
  paneId: string;
  generation: number;
  sequence: number;
  offset?: number;
}

const DEFAULT_TMUX_OUTPUT_POLL_INTERVAL_MS = 500;
const DEFAULT_TMUX_OUTPUT_MAX_TRANSPORT_BYTES = 1024 * 1024;
const DEFAULT_TMUX_OUTPUT_STARTUP_MAX_SESSIONS = 8;
const DEFAULT_TMUX_OUTPUT_STARTUP_CONCURRENCY = 2;
const PANE_OUTPUT_BOUNDARY_TIMEOUT_MS = 2_000;
const tmuxOutputLogger = logger.child({ component: "terminal" });

export class TmuxOutputWatcher {
  private readonly outputDir: string;
  private readonly pollIntervalMs: number;
  private readonly maxTransportBytes: number;
  private readonly terminalSessionManager: TerminalSessionManager;
  private readonly tmuxService: TmuxService;
  private readonly tmuxLifecycleCoordinator?: TmuxLifecycleCoordinator;
  private readonly startupMaxSessions: number;
  private readonly startupConcurrency: number;
  private readonly watchedPanes = new Map<string, WatchedTmuxPane>();
  private pollTimer: NodeJS.Timeout | null = null;
  private nextWatcherGeneration = 1;
  private readonly outputPoller: TmuxOutputPoller;
  private disposed = false;

  constructor(options: TmuxOutputWatcherOptions) {
    this.outputDir = options.outputDir;
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_TMUX_OUTPUT_POLL_INTERVAL_MS;
    this.maxTransportBytes =
      options.maxTransportBytes ?? DEFAULT_TMUX_OUTPUT_MAX_TRANSPORT_BYTES;
    this.startupMaxSessions =
      options.startupMaxSessions ?? DEFAULT_TMUX_OUTPUT_STARTUP_MAX_SESSIONS;
    this.startupConcurrency = Math.max(
      1,
      options.startupConcurrency ?? DEFAULT_TMUX_OUTPUT_STARTUP_CONCURRENCY,
    );
    this.terminalSessionManager = options.terminalSessionManager;
    this.tmuxService = options.tmuxService;
    this.tmuxLifecycleCoordinator = options.tmuxLifecycleCoordinator;
    this.outputPoller = new TmuxOutputPoller(
      this.terminalSessionManager,
      this.tmuxService,
      this.tmuxLifecycleCoordinator,
      this.maxTransportBytes,
      this.watchedPanes,
      (terminalSessionId) => this.unwatchSession(terminalSessionId),
      (watched) => this.invalidatePaneCursor(watched),
    );
  }

  async watchExistingSessions(): Promise<void> {
    const sessions = this.terminalSessionManager
      .listSessions()
      .filter((session) => shouldWatchSession(session))
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
    const selectedSessions = sessions.slice(0, this.startupMaxSessions);
    const skippedCount = Math.max(0, sessions.length - selectedSessions.length);
    if (skippedCount > 0) {
      tmuxOutputLogger.info("terminal.tmux.output-watch.startup.limited", {
        message: "Limited tmux output watcher startup recovery",
        selectedCount: selectedSessions.length,
        skippedCount,
        totalCount: sessions.length,
      });
    }

    for (
      let index = 0;
      index < selectedSessions.length;
      index += this.startupConcurrency
    ) {
      await Promise.all(
        selectedSessions
          .slice(index, index + this.startupConcurrency)
          .map((session) => this.watchSession(session)),
      );
    }
    tmuxOutputLogger.info("terminal.tmux.output-watch.startup.recovered", {
      message: "Recovered tmux output watchers for existing sessions",
      selectedCount: selectedSessions.length,
      totalCount: sessions.length,
    });
  }

  async watchSession(session: TerminalSessionRecord): Promise<void> {
    if (this.disposed || !shouldWatchSession(session)) {
      return;
    }

    const target = resolveTmuxTarget(session, this.tmuxService);
    const hasSession = await this.tmuxService
      .hasSession(target)
      .catch(() => true);
    if (
      !isInteractiveShellLaunch(session.command, session.args) &&
      !hasSession
    ) {
      await this.terminalSessionManager.updateSessionMetadata(session.id, {
        cwd: session.cwd,
        activeCommand: null,
      });
      const shouldFinalizeExit =
        this.tmuxLifecycleCoordinator?.shouldFinalizeNonInteractiveExit(
          session.id,
        ) ?? true;
      if (shouldFinalizeExit) {
        this.terminalSessionManager.markExited(session.id);
      }
      tmuxOutputLogger.info("terminal.tmux.output-watch.session-missing", {
        message: "Finalized missing non-interactive tmux session",
        terminalSessionId: session.id,
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        finalized: shouldFinalizeExit,
      });
      return;
    }
    const paneId = await this.tmuxService.readSelectedPane(target);
    if (!paneId) {
      tmuxOutputLogger.warn("terminal.tmux.output-watch.pane-missing", {
        message: "Failed to resolve selected tmux pane for output watcher",
        terminalSessionId: session.id,
        sessionName: target.sessionName,
        socketPath: target.socketPath,
      });
      return;
    }
    const paneTarget = { ...target, paneId };
    const existingLifecycleWatcher = Array.from(
      this.watchedPanes.values(),
    ).find(
      (watched) =>
        watched.terminalSessionId === session.id &&
        watched.reconcileSessionLifecycle,
    );
    if (
      existingLifecycleWatcher &&
      isSamePaneTarget(existingLifecycleWatcher.target, paneTarget)
    ) {
      existingLifecycleWatcher.recordSessionOutput = true;
      return;
    }

    if (existingLifecycleWatcher) {
      const existingKey = resolvePaneWatcherKey(
        session.id,
        existingLifecycleWatcher.target.paneId,
      );
      this.watchedPanes.delete(existingKey);
      await this.stopPipe(session.id, existingLifecycleWatcher);
    }
    await this.ensurePaneWatcher(session, paneTarget, {
      reconcileSessionLifecycle: true,
      recordSessionOutput: true,
    });
  }

  async capturePaneOutputCursorAndSendInput(
    session: TerminalSessionRecord,
    target: TmuxPaneTarget,
    input: string,
  ): Promise<TmuxPaneOutputCursor | null> {
    if (this.disposed || !shouldWatchSession(session)) {
      return null;
    }
    const sessionTarget = resolveTmuxTarget(session, this.tmuxService);
    if (!isSameTmuxSessionTarget(sessionTarget, target)) {
      return null;
    }
    const watched = await this.ensurePaneWatcher(session, target, {
      reconcileSessionLifecycle: false,
      recordSessionOutput: false,
    });
    if (!watched) {
      return null;
    }
    const polled = await this.outputPoller.pollPane(watched);
    const current = this.watchedPanes.get(
      resolvePaneWatcherKey(session.id, target.paneId),
    );
    if (!polled || current !== watched) {
      return null;
    }
    const generation = watched.generation;
    const markerSearchCursor = captureScrollbackBufferCursor(
      watched.outputBuffer,
    );
    const markerId = randomUUID();
    const marker = `\u001b]777;runweave-pane-boundary=${markerId}\u0007`;
    try {
      await this.tmuxService.writePaneOutput(target, marker);
      await this.tmuxService.sendInput(target, `${input}\r`);
    } catch (error) {
      tmuxOutputLogger.debug("terminal.tmux.output-watch.boundary.failed", {
        message: "Failed to establish boundary and send pane input",
        terminalSessionId: session.id,
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        paneId: target.paneId,
        error,
      });
      return null;
    }
    const deadline = Date.now() + PANE_OUTPUT_BOUNDARY_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const markerPolled = await this.outputPoller.pollPane(watched);
      const markerWatcher = this.watchedPanes.get(
        resolvePaneWatcherKey(session.id, target.paneId),
      );
      if (
        !markerPolled ||
        markerWatcher !== watched ||
        watched.generation !== generation ||
        !isSamePaneTarget(watched.target, target)
      ) {
        return null;
      }
      const markerPosition = findScrollbackBufferPositionAfterMarker(
        watched.outputBuffer,
        markerSearchCursor,
        marker,
      );
      if (markerPosition) {
        return {
          terminalSessionId: session.id,
          paneId: target.paneId,
          generation: watched.generation,
          sequence: markerPosition.sequence,
          offset: markerPosition.offset,
        };
      }
      await waitForPaneOutputBoundary();
    }
    tmuxOutputLogger.debug("terminal.tmux.output-watch.boundary.timeout", {
      message: "Timed out waiting for pane-local output boundary marker",
      terminalSessionId: session.id,
      sessionName: target.sessionName,
      socketPath: target.socketPath,
      paneId: target.paneId,
    });
    return null;
  }

  async readPaneOutputSince(
    target: TmuxPaneTarget,
    cursor: TmuxPaneOutputCursor,
  ): Promise<string | null> {
    if (this.disposed || cursor.paneId !== target.paneId) {
      return null;
    }
    const watched = this.watchedPanes.get(
      resolvePaneWatcherKey(cursor.terminalSessionId, cursor.paneId),
    );
    if (
      !watched ||
      watched.generation !== cursor.generation ||
      !isSamePaneTarget(watched.target, target)
    ) {
      return null;
    }
    const polled = await this.outputPoller.pollPane(watched);
    const current = this.watchedPanes.get(
      resolvePaneWatcherKey(cursor.terminalSessionId, cursor.paneId),
    );
    if (
      !polled ||
      current !== watched ||
      watched.generation !== cursor.generation ||
      !isSamePaneTarget(watched.target, target)
    ) {
      return null;
    }
    return readScrollbackBufferFromPosition(
      watched.outputBuffer,
      cursor.sequence,
      cursor.offset ?? 0,
    );
  }

  async unwatchPane(terminalSessionId: string, paneId: string): Promise<void> {
    const key = resolvePaneWatcherKey(terminalSessionId, paneId);
    const watched = this.watchedPanes.get(key);
    if (!watched) {
      return;
    }
    this.watchedPanes.delete(key);
    await this.stopPipe(terminalSessionId, watched);
    this.stopPollingIfIdle();
  }

  async unwatchSession(terminalSessionId: string): Promise<void> {
    const watchedPanes = Array.from(this.watchedPanes.entries()).filter(
      ([, watched]) => watched.terminalSessionId === terminalSessionId,
    );
    watchedPanes.forEach(([key]) => this.watchedPanes.delete(key));
    await Promise.all(
      watchedPanes.map(([, watched]) =>
        this.stopPipe(terminalSessionId, watched),
      ),
    );
    this.stopPollingIfIdle();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await Promise.all(
      Array.from(this.watchedPanes.values()).map((watched) =>
        this.stopPipe(watched.terminalSessionId, watched),
      ),
    );
    this.watchedPanes.clear();
  }

  private async ensurePaneWatcher(
    session: TerminalSessionRecord,
    target: TmuxPaneTarget,
    options: {
      reconcileSessionLifecycle: boolean;
      recordSessionOutput: boolean;
    },
  ): Promise<WatchedTmuxPane | null> {
    const key = resolvePaneWatcherKey(session.id, target.paneId);
    const existing = this.watchedPanes.get(key);
    if (existing && isSamePaneTarget(existing.target, target)) {
      existing.reconcileSessionLifecycle ||= options.reconcileSessionLifecycle;
      existing.recordSessionOutput ||= options.recordSessionOutput;
      return existing;
    }

    if (existing) {
      this.watchedPanes.delete(key);
      await this.stopPipe(session.id, existing);
    }

    const filePath = this.resolveOutputPath(session.id, target.paneId);
    try {
      await mkdir(this.outputDir, { recursive: true });
      await writeFile(filePath, "", { flag: "a" });
      await this.tmuxService.pipePaneOutput(target, filePath);
    } catch (error) {
      tmuxOutputLogger.warn("terminal.tmux.output-watch.setup.failed", {
        message: "Failed to enable pane-local tmux output watcher",
        terminalSessionId: session.id,
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        paneId: target.paneId,
        error,
      });
      return null;
    }

    const watched: WatchedTmuxPane = {
      decoder: new StringDecoder("utf8"),
      filePath,
      generation: this.nextWatcherGeneration,
      offset: 0,
      outputBuffer: createScrollbackBuffer("", this.maxTransportBytes),
      polling: null,
      recordSessionOutput: options.recordSessionOutput,
      reconcileSessionLifecycle: options.reconcileSessionLifecycle,
      recorder: createTerminalRuntimeRecorder(
        this.terminalSessionManager,
        session.id,
      ),
      target,
      terminalSessionId: session.id,
    };
    this.nextWatcherGeneration += 1;
    this.watchedPanes.set(key, watched);
    this.ensurePolling();
    return watched;
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.watchedPanes.size === 0) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private stopPollingIfIdle(): void {
    if (this.watchedPanes.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollAll(): Promise<void> {
    await this.removeMissingPaneWatchers();
    await Promise.all(
      Array.from(this.watchedPanes.values()).map((watched) =>
        this.outputPoller.pollPane(watched),
      ),
    );
  }

  private async removeMissingPaneWatchers(): Promise<void> {
    const watchedBySession = new Map<string, WatchedTmuxPane[]>();
    for (const watched of this.watchedPanes.values()) {
      const sessionWatchers = watchedBySession.get(watched.terminalSessionId);
      if (sessionWatchers) {
        sessionWatchers.push(watched);
      } else {
        watchedBySession.set(watched.terminalSessionId, [watched]);
      }
    }
    await Promise.all(
      Array.from(watchedBySession.entries()).map(
        async ([terminalSessionId, watchedPanes]) => {
          const session =
            this.terminalSessionManager.getSession(terminalSessionId);
          if (!session || !shouldWatchSession(session)) {
            await this.unwatchSession(terminalSessionId);
            return;
          }
          let livePaneIds: Set<string>;
          try {
            livePaneIds = new Set(
              (await this.tmuxService.listPanes(watchedPanes[0]!.target)).map(
                (pane) => pane.paneId,
              ),
            );
          } catch {
            return;
          }
          await Promise.all(
            watchedPanes
              .filter((watched) => !livePaneIds.has(watched.target.paneId))
              .map((watched) =>
                this.unwatchPane(terminalSessionId, watched.target.paneId),
              ),
          );
        },
      ),
    );
  }

  private invalidatePaneCursor(watched: WatchedTmuxPane): void {
    watched.generation = this.nextWatcherGeneration;
    this.nextWatcherGeneration += 1;
    watched.outputBuffer = createScrollbackBuffer("", this.maxTransportBytes);
  }

  private async stopPipe(
    terminalSessionId: string,
    watched: WatchedTmuxPane,
  ): Promise<void> {
    try {
      await this.tmuxService.stopPaneOutputPipe(watched.target);
    } catch (error) {
      tmuxOutputLogger.debug("terminal.tmux.output-watch.stop.failed", {
        message: "Failed to stop tmux output pipe",
        terminalSessionId,
        sessionName: watched.target.sessionName,
        socketPath: watched.target.socketPath,
        error,
      });
    }
  }

  private resolveOutputPath(terminalSessionId: string, paneId: string): string {
    return path.join(
      this.outputDir,
      `${sanitizeOutputPathSegment(terminalSessionId)}--${sanitizeOutputPathSegment(paneId)}.log`,
    );
  }
}
