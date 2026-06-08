import { createReadStream } from "node:fs";
import { mkdir, stat, truncate } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../logging";
import { createTerminalRuntimeRecorder } from "./runtime-recorder";
import type { TerminalSessionManager, TerminalSessionRecord } from "./manager";
import type { TmuxService, TmuxTarget } from "./tmux-service";

interface TmuxOutputWatcherOptions {
  outputDir: string;
  terminalSessionManager: TerminalSessionManager;
  tmuxService: TmuxService;
  pollIntervalMs?: number;
  maxTransportBytes?: number;
}

interface WatchedTmuxSession {
  decoder: StringDecoder;
  filePath: string;
  offset: number;
  polling: boolean;
  recorder: ReturnType<typeof createTerminalRuntimeRecorder>;
  target: TmuxTarget;
}

const DEFAULT_TMUX_OUTPUT_POLL_INTERVAL_MS = 500;
const DEFAULT_TMUX_OUTPUT_MAX_TRANSPORT_BYTES = 1024 * 1024;
const FORCE_TRUNCATE_TRANSPORT_BYTES_MULTIPLIER = 2;
const tmuxOutputLogger = logger.child({ component: "terminal" });

export class TmuxOutputWatcher {
  private readonly outputDir: string;
  private readonly pollIntervalMs: number;
  private readonly maxTransportBytes: number;
  private readonly terminalSessionManager: TerminalSessionManager;
  private readonly tmuxService: TmuxService;
  private readonly watchedSessions = new Map<string, WatchedTmuxSession>();
  private pollTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(options: TmuxOutputWatcherOptions) {
    this.outputDir = options.outputDir;
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_TMUX_OUTPUT_POLL_INTERVAL_MS;
    this.maxTransportBytes =
      options.maxTransportBytes ?? DEFAULT_TMUX_OUTPUT_MAX_TRANSPORT_BYTES;
    this.terminalSessionManager = options.terminalSessionManager;
    this.tmuxService = options.tmuxService;
  }

  async watchExistingSessions(): Promise<void> {
    await Promise.all(
      this.terminalSessionManager
        .listSessions()
        .filter((session) => shouldWatchSession(session))
        .map((session) => this.watchSession(session)),
    );
  }

  async watchSession(session: TerminalSessionRecord): Promise<void> {
    if (this.disposed || !shouldWatchSession(session)) {
      return;
    }

    const target = resolveTmuxTarget(session, this.tmuxService);
    const filePath = this.resolveOutputPath(session.id);
    const existing = this.watchedSessions.get(session.id);
    if (
      existing &&
      existing.filePath === filePath &&
      existing.target.sessionName === target.sessionName &&
      existing.target.socketPath === target.socketPath
    ) {
      return;
    }

    try {
      if (existing) {
        this.watchedSessions.delete(session.id);
        await this.stopPipe(session.id, existing);
      }
      await mkdir(this.outputDir, { recursive: true });
      await this.tmuxService.pipePaneOutput(target, filePath);
    } catch (error) {
      tmuxOutputLogger.warn("terminal.tmux.output-watch.setup.failed", {
        message: "Failed to enable tmux output watcher",
        terminalSessionId: session.id,
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        error,
      });
      return;
    }

    this.watchedSessions.set(session.id, {
      decoder: new StringDecoder("utf8"),
      filePath,
      offset: 0,
      polling: false,
      recorder: createTerminalRuntimeRecorder(
        this.terminalSessionManager,
        session.id,
      ),
      target,
    });
    this.ensurePolling();
  }

  async unwatchSession(terminalSessionId: string): Promise<void> {
    const watched = this.watchedSessions.get(terminalSessionId);
    this.watchedSessions.delete(terminalSessionId);
    if (watched) {
      await this.stopPipe(terminalSessionId, watched);
    }
    if (this.watchedSessions.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await Promise.all(
      Array.from(this.watchedSessions.entries()).map(
        async ([terminalSessionId, watched]) => {
          await this.stopPipe(terminalSessionId, watched);
        },
      ),
    );
    this.watchedSessions.clear();
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.watchedSessions.size === 0) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private async pollAll(): Promise<void> {
    await Promise.all(
      Array.from(this.watchedSessions.entries()).map(
        async ([terminalSessionId, watched]) => {
          await this.pollSession(terminalSessionId, watched);
        },
      ),
    );
  }

  private async pollSession(
    terminalSessionId: string,
    watched: WatchedTmuxSession,
  ): Promise<void> {
    if (watched.polling) {
      return;
    }
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    if (!session || !shouldWatchSession(session)) {
      await this.unwatchSession(terminalSessionId);
      return;
    }

    watched.polling = true;
    try {
      const fileStat = await stat(watched.filePath);
      if (fileStat.size < watched.offset) {
        watched.offset = 0;
      }
      if (fileStat.size === watched.offset) {
        return;
      }
      if (fileStat.size > this.maxTransportBytes) {
        tmuxOutputLogger.warn(
          "terminal.tmux.output-watch.transport-truncated",
          {
            message:
              "Tmux output transport exceeded quota; older output will be skipped",
            terminalSessionId,
            bytes: fileStat.size,
            maxBytes: this.maxTransportBytes,
          },
        );
        watched.offset = Math.max(0, fileStat.size - this.maxTransportBytes);
      }

      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(watched.filePath, {
          start: watched.offset,
          end: fileStat.size - 1,
        });
        stream.on("data", (chunk) => {
          const output = watched.decoder.write(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          );
          if (output) {
            watched.recorder.onData(output);
          }
        });
        stream.on("error", reject);
        stream.on("end", resolve);
      });
      watched.offset = fileStat.size;
      await this.truncateTransportIfDrained(terminalSessionId, watched);
    } catch (error) {
      tmuxOutputLogger.debug("terminal.tmux.output-watch.failed", {
        message: "Tmux output watch poll failed",
        terminalSessionId,
        sessionName: watched.target.sessionName,
        socketPath: watched.target.socketPath,
        error,
      });
    } finally {
      watched.polling = false;
    }
  }

  private async truncateTransportIfDrained(
    terminalSessionId: string,
    watched: WatchedTmuxSession,
  ): Promise<void> {
    const latestStat = await stat(watched.filePath);
    if (latestStat.size !== watched.offset) {
      if (
        latestStat.size <=
        this.maxTransportBytes * FORCE_TRUNCATE_TRANSPORT_BYTES_MULTIPLIER
      ) {
        return;
      }
      tmuxOutputLogger.warn("terminal.tmux.output-watch.transport-reset", {
        message:
          "Tmux output transport exceeded hard quota; pending output will be dropped",
        terminalSessionId,
        bytes: latestStat.size,
        maxBytes: this.maxTransportBytes,
      });
      await truncate(watched.filePath, 0);
      watched.offset = 0;
      watched.decoder.end();
      watched.decoder = new StringDecoder("utf8");
      return;
    }

    await truncate(watched.filePath, 0);
    watched.offset = 0;
    const remainingOutput = watched.decoder.end();
    if (remainingOutput) {
      watched.recorder.onData(remainingOutput);
    }
    watched.decoder = new StringDecoder("utf8");
  }

  private async stopPipe(
    terminalSessionId: string,
    watched: WatchedTmuxSession,
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

  private resolveOutputPath(terminalSessionId: string): string {
    return path.join(
      this.outputDir,
      `${terminalSessionId.replace(/[^A-Za-z0-9_-]+/g, "-")}.log`,
    );
  }
}

function shouldWatchSession(
  session: Pick<TerminalSessionRecord, "runtimeKind" | "status">,
): boolean {
  return session.runtimeKind === "tmux" && session.status === "running";
}

function resolveTmuxTarget(
  session: TerminalSessionRecord,
  tmuxService: TmuxService,
): TmuxTarget {
  return {
    sessionName:
      session.tmuxSessionName ?? tmuxService.buildSessionName(session.id),
    socketPath: session.tmuxSocketPath ?? tmuxService.socketPath,
  };
}
