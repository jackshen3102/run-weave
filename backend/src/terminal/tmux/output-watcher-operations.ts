import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { logger } from "../../logging/index";
import type { TmuxService } from "./service";
import { sanitizeOutputPathSegment, type WatchedTmuxPane } from "./output-watcher-helpers";

const outputLogger = logger.child({ component: "terminal" });

/** Serializes pipe ownership changes without re-entering the tmux session lock. */
export class TmuxOutputWatcherOperations {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly outputDir: string, private readonly tmuxService: TmuxService) {}

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sessionId);
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.pending.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(sessionId) === current) this.pending.delete(sessionId);
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(this.pending.values());
  }

  outputPath(sessionId: string, paneId: string): string {
    return path.join(this.outputDir, `${sanitizeOutputPathSegment(sessionId)}--${sanitizeOutputPathSegment(paneId)}.log`);
  }

  async stop(watched: WatchedTmuxPane, discardTransport = true): Promise<void> {
    // The caller removes this generation from the map before entering here.
    // A poll may still hold its file descriptor or be compacting the transport.
    await watched.polling?.catch(error => {
      outputLogger.warn("terminal.tmux.output-watch.poll.failed", {
        message: "Pending output poll failed during pipe cleanup",
        terminalSessionId: watched.terminalSessionId,
        error,
      });
    });
    try {
      await this.tmuxService.stopPaneOutputPipe(watched.target);
    } catch (error) {
      outputLogger.debug("terminal.tmux.output-watch.stop.failed", {
        message: "Failed to stop tmux output pipe",
        terminalSessionId: watched.terminalSessionId,
        sessionName: watched.target.sessionName,
        socketPath: watched.target.socketPath,
        error,
      });
    }
    if (discardTransport) await rm(watched.filePath, { force: true });
  }

  async stopAll(watched: Iterable<WatchedTmuxPane>, discardTransport = true): Promise<void> {
    await this.settleAll(Array.from(watched, pane => this.stop(pane, discardTransport)));
  }

  private async settleAll(operations: Promise<unknown>[]): Promise<void> {
    const results = await Promise.allSettled(operations);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Tmux output transport cleanup failed");
  }

  async removePaneTransport(sessionId: string, paneId: string): Promise<void> {
    await rm(this.outputPath(sessionId, paneId), { force: true });
  }

  async removeSessionTransports(sessionId: string): Promise<void> {
    // Also reclaim persisted transports that were outside the startup watch limit.
    const prefix = `${sanitizeOutputPathSegment(sessionId)}--`;
    const entries = await readdir(this.outputDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    await this.settleAll(entries.filter(name => name.startsWith(prefix) && name.endsWith(".log"))
      .map(name => rm(path.join(this.outputDir, name), { force: true })));
  }
}
