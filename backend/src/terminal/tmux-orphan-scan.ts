import type { TerminalSessionManager } from "./manager";
import { isTmuxBackedSession } from "./runtime-launcher";
import type { TmuxSessionInfo, TmuxService } from "./tmux-service";

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
    console.warn("[viewer-be] skipped orphaned tmux session scan", {
      socketPath: scanner.socketPath,
      reason: unavailableReason ?? "tmux unavailable",
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
      console.warn("[viewer-be] found orphaned tmux sessions", {
        count: orphanedSessions.length,
        socketPath: scanner.socketPath,
        sessionNames: orphanedSessions.map((session) => session.sessionName),
      });
    }
  } catch (error) {
    console.warn("[viewer-be] failed to scan orphaned tmux sessions", {
      socketPath: scanner.socketPath,
      error: String(error),
    });
  }
}
