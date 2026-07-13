import { createReadStream } from "node:fs";
import { stat, truncate } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../logging";
import type { TerminalSessionManager, TerminalSessionRecord } from "./manager";
import { appendToScrollbackBuffer } from "./scrollback-buffer";
import type { TmuxLifecycleCoordinator } from "./tmux-lifecycle-coordinator";
import {
  isInteractiveShellLaunch,
  resolvePaneWatcherKey,
  shouldWatchSession,
  type WatchedTmuxPane,
} from "./tmux-output-watcher-helpers";
import type { TmuxService } from "./tmux-service";

const FORCE_TRUNCATE_TRANSPORT_BYTES_MULTIPLIER = 2;
const tmuxOutputLogger = logger.child({ component: "terminal" });

export class TmuxOutputPoller {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly tmuxService: TmuxService,
    private readonly tmuxLifecycleCoordinator:
      | TmuxLifecycleCoordinator
      | undefined,
    private readonly maxTransportBytes: number,
    private readonly watchedPanes: Map<string, WatchedTmuxPane>,
    private readonly unwatchSession: (
      terminalSessionId: string,
    ) => Promise<void>,
    private readonly invalidatePaneCursor: (watched: WatchedTmuxPane) => void,
  ) {}

  async pollPane(watched: WatchedTmuxPane): Promise<boolean> {
    if (watched.polling) {
      return watched.polling;
    }
    watched.polling = this.pollPaneNow(watched).finally(() => {
      watched.polling = null;
    });
    return watched.polling;
  }

  private async pollPaneNow(watched: WatchedTmuxPane): Promise<boolean> {
    const terminalSessionId = watched.terminalSessionId;
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    if (!session || !shouldWatchSession(session)) {
      await this.unwatchSession(terminalSessionId);
      return false;
    }

    try {
      if (
        watched.reconcileSessionLifecycle &&
        (await this.reconcileNonInteractiveSessionExit(session, watched))
      ) {
        return false;
      }
      const fileStat = await stat(watched.filePath);
      if (fileStat.size < watched.offset) {
        watched.offset = 0;
        this.invalidatePaneCursor(watched);
      }
      if (fileStat.size === watched.offset) {
        return true;
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
        this.invalidatePaneCursor(watched);
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
            appendToScrollbackBuffer(watched.outputBuffer, output);
            if (watched.recordSessionOutput) {
              watched.recorder.onData(output);
            }
          }
        });
        stream.on("error", reject);
        stream.on("end", resolve);
      });
      watched.offset = fileStat.size;
      await this.truncateTransportIfDrained(terminalSessionId, watched);
      return true;
    } catch (error) {
      const key = resolvePaneWatcherKey(
        watched.terminalSessionId,
        watched.target.paneId,
      );
      if (this.watchedPanes.get(key) === watched) {
        this.invalidatePaneCursor(watched);
      }
      tmuxOutputLogger.debug("terminal.tmux.output-watch.failed", {
        message: "Tmux output watch poll failed",
        terminalSessionId,
        sessionName: watched.target.sessionName,
        socketPath: watched.target.socketPath,
        error,
      });
      return false;
    }
  }

  private async reconcileNonInteractiveSessionExit(
    session: TerminalSessionRecord,
    watched: WatchedTmuxPane,
  ): Promise<boolean> {
    if (
      !session.activeCommand ||
      isInteractiveShellLaunch(session.command, session.args)
    ) {
      return false;
    }

    let metadata: Awaited<ReturnType<TmuxService["readPaneMetadata"]>>;
    try {
      metadata = await this.tmuxService.readPaneMetadata(
        watched.target,
        session.command,
      );
    } catch {
      const hasSession = await this.tmuxService
        .hasSession(watched.target)
        .catch(() => true);
      if (hasSession) {
        return false;
      }
      metadata = null;
    }
    if (metadata?.activeCommand) {
      return false;
    }

    await this.terminalSessionManager.updateSessionMetadata(session.id, {
      cwd: session.cwd,
      activeCommand: null,
    });
    const shouldFinalizeExit =
      this.tmuxLifecycleCoordinator?.shouldFinalizeNonInteractiveExit(
        session.id,
      ) ?? true;
    if (!shouldFinalizeExit) {
      await this.unwatchSession(session.id);
      return true;
    }
    this.terminalSessionManager.markExited(session.id);
    await this.unwatchSession(session.id);
    return true;
  }

  private async truncateTransportIfDrained(
    terminalSessionId: string,
    watched: WatchedTmuxPane,
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
      this.invalidatePaneCursor(watched);
      watched.decoder.end();
      watched.decoder = new StringDecoder("utf8");
      return;
    }

    await truncate(watched.filePath, 0);
    watched.offset = 0;
    const remainingOutput = watched.decoder.end();
    if (remainingOutput) {
      appendToScrollbackBuffer(watched.outputBuffer, remainingOutput);
      if (watched.recordSessionOutput) {
        watched.recorder.onData(remainingOutput);
      }
    }
    watched.decoder = new StringDecoder("utf8");
  }
}
