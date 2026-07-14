import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import { isTmuxBackedSession } from "../terminal/runtime-launcher";
import type {
  TmuxOutputWatcher,
  TmuxPaneOutputCursor,
} from "../terminal/tmux-output-watcher";
import type { TmuxPaneTarget } from "../terminal/tmux-service";
import { AgentTeamError } from "./errors";

export type TraeStartupOutputBoundary =
  | {
      kind: "pty";
      cursor: number;
    }
  | {
      kind: "tmux-pane";
      cursor: TmuxPaneOutputCursor;
      target: TmuxPaneTarget;
    };

type TraeStartupOutputBoundaryDependencies = {
  terminalSessionManager: TerminalSessionManager;
  tmuxOutputWatcher?: TmuxOutputWatcher;
};

export async function captureTraeStartupOutputBoundary(
  dependencies: TraeStartupOutputBoundaryDependencies,
  session: TerminalSessionRecord,
  paneTarget: TmuxPaneTarget | undefined,
  tmuxStartInput?: string,
): Promise<TraeStartupOutputBoundary> {
  if (isTmuxBackedSession(session)) {
    if (!paneTarget || !dependencies.tmuxOutputWatcher || !tmuxStartInput) {
      throw createTraeOutputBoundaryError(session, paneTarget);
    }
    const cursor =
      await dependencies.tmuxOutputWatcher.capturePaneOutputCursorAndSendInput(
        session,
        paneTarget,
        tmuxStartInput,
      );
    if (!cursor) {
      throw createTraeOutputBoundaryError(session, paneTarget);
    }
    return { kind: "tmux-pane", cursor, target: paneTarget };
  }

  const cursor =
    await dependencies.terminalSessionManager.captureOutputCursor(session.id);
  if (cursor === null) {
    throw createTraeOutputBoundaryError(session, paneTarget);
  }
  return { kind: "pty", cursor };
}

export async function readTraeStartupOutput(
  dependencies: TraeStartupOutputBoundaryDependencies,
  session: TerminalSessionRecord,
  boundary: TraeStartupOutputBoundary | undefined,
): Promise<string | null> {
  if (!boundary) {
    return null;
  }
  if (boundary.kind === "tmux-pane") {
    return (
      (await dependencies.tmuxOutputWatcher?.readPaneOutputSince(
        boundary.target,
        boundary.cursor,
      )) ?? null
    );
  }
  return dependencies.terminalSessionManager.readOutputSince(
    session.id,
    boundary.cursor,
  );
}

function createTraeOutputBoundaryError(
  session: TerminalSessionRecord,
  paneTarget: TmuxPaneTarget | undefined,
): AgentTeamError {
  return new AgentTeamError(
    409,
    `Failed to establish pane-local output boundary for agent-team agent "traex"`,
    {
      terminalSessionId: session.id,
      panelId: paneTarget?.paneId ?? null,
      reason: "startup_output_boundary_unavailable",
    },
  );
}
