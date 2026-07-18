import type {
  AgentTeamFixtureResourceCleanup,
  AgentTeamRun,
} from "@runweave/shared/agent-team";
import type { TerminalSessionManager } from "../terminal/manager";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TmuxService } from "../terminal/tmux-service";
import { buildPaneTarget } from "../terminal/application/panel-common";
import {
  isTmuxBackedSession,
  killTmuxSessionForTerminal,
  resolveTmuxTarget,
} from "../terminal/runtime-launcher";

interface FixtureResourceCleanupOptions {
  terminalSessionManager: TerminalSessionManager;
  runtimeRegistry: TerminalRuntimeRegistry;
  terminalEventService: TerminalEventService;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  protectedTerminalSessionIds?: ReadonlySet<string>;
}

export async function cleanupAgentTeamFixtureResources(
  run: AgentTeamRun,
  options: FixtureResourceCleanupOptions,
): Promise<AgentTeamFixtureResourceCleanup> {
  const attemptedAt = new Date().toISOString();
  const errors: string[] = [];
  const cleanedPanelIds: string[] = [];
  const session = options.terminalSessionManager.getSession(
    run.terminalSessionId,
  );
  const ownsTerminalSession = run.lineage?.ownsTerminalSession === true;
  let terminalSessionDestroyed = !session && ownsTerminalSession;

  if (
    session &&
    ownsTerminalSession &&
    options.protectedTerminalSessionIds?.has(session.id)
  ) {
    errors.push(
      `terminal ${session.id}: refusing to destroy the owner Run terminal`,
    );
  } else if (session && ownsTerminalSession) {
    await captureCleanupError(errors, "runtime", () =>
      options.runtimeRegistry.disposeRuntime(session.id),
    );
    await captureCleanupError(errors, "tmux watcher", () =>
      options.tmuxOutputWatcher?.unwatchSession(session.id),
    );
    await captureCleanupError(errors, "tmux session", async () => {
      if (isTmuxBackedSession(session) && !options.tmuxService) {
        throw new Error("tmux service unavailable");
      }
      await killTmuxSessionForTerminal(session, options.tmuxService);
      if (
        options.tmuxService &&
        isTmuxBackedSession(session) &&
        (await options.tmuxService.hasSession(
          resolveTmuxTarget(session, options.tmuxService),
        ))
      ) {
        throw new Error("tmux session is still live after cleanup");
      }
    });
    if (errors.length === 0) {
      try {
        terminalSessionDestroyed =
          (await options.terminalSessionManager.destroySession(session.id)) ||
          !options.terminalSessionManager.getSession(session.id);
      } catch (error) {
        errors.push(`terminal record: ${formatCleanupError(error)}`);
      }
    }
    if (terminalSessionDestroyed) {
      options.terminalEventService.record({
        kind: "terminal_session_deleted",
        terminalSessionId: session.id,
        projectId: session.projectId,
        payload: {
          terminalSessionId: session.id,
          source: "agent_team_fixture_cleanup",
          runId: run.runId,
        } as never,
      });
    }
  } else if (session) {
    const ownedPanels = options.terminalSessionManager
      .listPanels(session.id)
      .filter(
        (panel) =>
          panel.agentTeamRunId === run.runId &&
          panel.id !== run.mainPanelId,
      );
    for (const panel of ownedPanels) {
      if (!options.tmuxService) {
        errors.push(`panel ${panel.id}: tmux service unavailable`);
        continue;
      }
      try {
        const paneTarget = buildPaneTarget(session, options.tmuxService, panel);
        const tmuxSessionExists = await options.tmuxService.hasSession(
          paneTarget,
        );
        const livePane = tmuxSessionExists
          ? (await options.tmuxService.listPanes(paneTarget)).find(
              (pane) => pane.paneId === paneTarget.paneId,
            )
          : null;
        if (livePane && livePane.runweavePanelId !== panel.id) {
          throw new Error(
            `refusing pane ${paneTarget.paneId}: panel identity does not match`,
          );
        }
        if (livePane) {
          await options.tmuxService.killPane(paneTarget);
        }
        await options.tmuxOutputWatcher?.unwatchPane(
          session.id,
          paneTarget.paneId,
        );
        await options.terminalSessionManager.markPanelExited(panel.id);
        await options.terminalSessionManager.removePanelFromWorkspace(
          session.id,
          panel.id,
        );
        cleanedPanelIds.push(panel.id);
        options.terminalEventService.record({
          kind: "terminal_panel_deleted",
          terminalSessionId: session.id,
          projectId: session.projectId,
          payload: {
            panelId: panel.id,
            source: "agent_team_fixture_cleanup",
            runId: run.runId,
          } as never,
        });
      } catch (error) {
        errors.push(`panel ${panel.id}: ${formatCleanupError(error)}`);
      }
    }
  }

  const completedAt = errors.length === 0 ? new Date().toISOString() : null;
  return {
    status: errors.length === 0 ? "completed" : "failed",
    attemptedAt,
    completedAt,
    terminalSessionId: run.terminalSessionId,
    terminalSessionDestroyed,
    cleanedPanelIds,
    preservedTerminalSession: !ownsTerminalSession,
    errors,
  };
}

async function captureCleanupError(
  errors: string[],
  label: string,
  cleanup: () => Promise<unknown> | undefined,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(`${label}: ${formatCleanupError(error)}`);
  }
}

function formatCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
