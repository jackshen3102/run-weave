import type { TerminalSessionManager } from "./manager";
import { logger } from "../logging";
import { isTmuxBackedSession } from "./runtime-launcher";
import type { TmuxSessionInfo, TmuxService } from "./tmux-service";

const terminalLogger = logger.child({ component: "terminal" });

interface TmuxOrphanScanner {
  readonly socketPath: string;
  buildSessionName(terminalSessionId: string): string;
  getUnavailableReason(): Promise<string | null>;
  isAvailable(): Promise<boolean>;
  listOrphanedSessions(
    knownSessionNames: ReadonlySet<string>,
  ): Promise<TmuxSessionInfo[]>;
}

export async function logOrphanedTmuxSessions(
  terminalSessionManager: Pick<TerminalSessionManager, "listSessions">,
  tmuxService: Pick<
    TmuxService,
    | "buildSessionName"
    | "getUnavailableReason"
    | "isAvailable"
    | "listOrphanedSessions"
    | "socketPath"
  >,
): Promise<void> {
  const scanner = tmuxService as TmuxOrphanScanner;
  let available = false;
  let unavailableReason: string | null = null;

  try {
    available = await scanner.isAvailable();
    if (!available) {
      unavailableReason = await scanner.getUnavailableReason();
    }
  } catch (error) {
    unavailableReason = `tmux availability probe failed: ${String(error)}`;
  }

  if (!available) {
    terminalLogger.warn("terminal.tmux.orphan.scan.skipped", {
      message: "Skipped orphaned tmux session scan",
      socketPath: scanner.socketPath,
      reason: unavailableReason ?? "tmux unavailable",
      legacyConsole: {
        method: "warn",
        message: "[viewer-be] skipped orphaned tmux session scan",
        meta: {
          socketPath: scanner.socketPath,
          reason: unavailableReason ?? "tmux unavailable",
        },
      },
    });
    return;
  }

  const knownSessionNames = new Set(
    terminalSessionManager
      .listSessions()
      .filter((session) => isTmuxBackedSession(session))
      .map(
        (session) =>
          session.tmuxSessionName ?? scanner.buildSessionName(session.id),
      ),
  );

  try {
    const orphanedSessions =
      await scanner.listOrphanedSessions(knownSessionNames);
    if (orphanedSessions.length > 0) {
      terminalLogger.warn("terminal.tmux.orphan.found", {
        message: "Found orphaned tmux sessions",
        count: orphanedSessions.length,
        socketPath: scanner.socketPath,
        sessionNames: orphanedSessions.map((session) => session.sessionName),
      });
    }
  } catch (error) {
    terminalLogger.warn("terminal.tmux.orphan.scan.failed", {
      message: "Failed to scan orphaned tmux sessions",
      socketPath: scanner.socketPath,
      error,
      legacyConsole: {
        method: "warn",
        message: "[viewer-be] failed to scan orphaned tmux sessions",
        meta: { socketPath: scanner.socketPath, error: String(error) },
      },
    });
  }
}
