import type { RuntimeServices } from "../bootstrap/runtime-services";
import { logger } from "../logging/index";
import {
  aggregatePanelTerminalState,
  getAgentForCommand,
} from "../terminal/state/terminal-state-service";
import type {
  TerminalPanelRecord,
  TerminalSessionRecord,
} from "../terminal/manager/manager";
import type { AppServerClient } from "./client";
import { toPanelListItem } from "../terminal/application/payloads";
import { recordPanelEvent } from "../terminal/application/panel-metadata";

const INTERVAL_MS = 30_000;
const MAX_PANELS_PER_ROUND = 8;
const ROUND_TIMEOUT_MS = 2_000;

type Services = Pick<
  RuntimeServices,
  "terminalSessionManager" | "terminalStateService" | "terminalEventService"
>;

// The integration's existing loop owns scheduling and shutdown. Unlike thread
// lifecycle polling, this also checks old threads with a stale local projection.
export class StartingPanelStateReconciler {
  private lastStartedAt = 0;
  private readonly checkedAt = new Map<string, number>();

  constructor(private readonly services: Services) {}

  async poll(client: AppServerClient, shutdown: AbortSignal): Promise<void> {
    if (shutdown.aborted || Date.now() - this.lastStartedAt < INTERVAL_MS)
      return;
    this.lastStartedAt = Date.now();
    const signal = AbortSignal.any([
      shutdown,
      AbortSignal.timeout(ROUND_TIMEOUT_MS),
    ]);
    const manager = this.services.terminalSessionManager;
    const candidates = manager.listSessions().flatMap((session) =>
      manager.listPanels(session.id).flatMap((panel) => {
        const candidate = this.capture(session, panel);
        return candidate ? [candidate] : [];
      }),
    );
    const ids = new Set(candidates.map(({ panel }) => panel.id));
    for (const id of this.checkedAt.keys())
      if (!ids.has(id)) this.checkedAt.delete(id);
    candidates.sort(
      (a, b) =>
        (this.checkedAt.get(a.panel.id) ?? 0) -
        (this.checkedAt.get(b.panel.id) ?? 0),
    );
    for (const candidate of candidates.slice(0, MAX_PANELS_PER_ROUND)) {
      if (signal.aborted) break;
      const {
        session,
        panel,
        threadId,
        agent,
        state,
        activity,
        command,
        paneId,
      } = candidate;
      this.checkedAt.set(panel.id, Date.now());
      try {
        // Read the projection only; /threads/:id also loads provider history.
        const response = await client.listThreads(
          { terminalSessionId: session.id, agent, limit: 1000 },
          signal,
        );
        const thread = response?.threads.find(
          (item) => item.threadId === threadId,
        );
        const current = this.capture(session, panel);
        if (
          signal.aborted ||
          !thread ||
          !current ||
          current.threadId !== threadId ||
          current.agent !== agent ||
          current.state !== state ||
          current.activity !== activity ||
          current.command !== command ||
          current.paneId !== paneId ||
          thread.threadId !== threadId ||
          thread.agent !== agent ||
          thread.identityStatus !== "resolved" ||
          thread.terminalSessionId !== session.id ||
          thread.projectId !== session.projectId ||
          thread.cwd !== panel.cwd ||
          (thread.terminalPanelId !== panel.id &&
            !(
              thread.terminalPanelId === null &&
              manager
                .listPanels(session.id)
                .filter((item) => item.status === "running").length === 1
            )) ||
          !Number.isFinite(Date.parse(thread.updatedAt)) ||
          Date.parse(thread.updatedAt) < activity.observedAt ||
          (thread.status !== "idle" && thread.status !== "running")
        )
          continue;

        // No await between the identity/version check and the panel update.
        // Do not replay hooks: that would also alter thread metadata and attention.
        await manager.updatePanelTerminalState(panel.id, {
          state: thread.status === "idle" ? "agent_idle" : "agent_running",
          agent,
        });
        if (
          manager.getSession(session.id) !== session ||
          session.status !== "running"
        )
          continue;
        const aggregate = aggregatePanelTerminalState(
          manager.listPanels(session.id),
        );
        this.services.terminalStateService.setAggregatedPanelAgentHookState(
          session.id,
          aggregate,
          session.projectId,
        );
        await manager.updateSessionTerminalState(session.id, aggregate);
        recordPanelEvent(
          manager,
          this.services.terminalEventService,
          session,
          "terminal_panel_updated",
          {
            panel: toPanelListItem(
              panel,
              manager.getPanelWorkspace(session.id)?.activePanelId ?? null,
            ),
          },
        );
        logger.info("terminal.panel-state.reconciled", {
          component: "terminal",
          message: "Reconciled starting panel from its current thread",
          terminalSessionId: session.id,
          panelId: panel.id,
          threadId,
          eventId: thread.lastEventId,
          state: panel.terminalState?.state,
        });
      } catch (error) {
        if (shutdown.aborted) break;
        logger.warn("terminal.panel-state.reconcile.failed", {
          component: "terminal",
          message: "Starting panel state reconciliation deferred",
          terminalSessionId: session.id,
          panelId: panel.id,
          error,
        });
      }
    }
  }

  private capture(session: TerminalSessionRecord, panel: TerminalPanelRecord) {
    const manager = this.services.terminalSessionManager;
    const state = panel.terminalState;
    const agent = state?.agent;
    const threadId = panel.threadId;
    const activity = manager.getRecentAgentActivity(session.id, panel.id);
    if (
      manager.getSession(session.id) !== session ||
      manager.getPanel(panel.id) !== panel ||
      session.status !== "running" ||
      panel.status !== "running" ||
      !manager.listPanels(session.id).some((item) => item.id === panel.id) ||
      state?.state !== "agent_starting" ||
      !agent ||
      agent === "pi" ||
      !threadId ||
      (panel.threadProvider ?? "codex") !== agent ||
      getAgentForCommand(panel.activeCommand) !== agent ||
      manager.hasPanelAgentPreparation(session.id, panel.id) ||
      manager.hasPanelAgentOperationGeneration(session.id, panel.id) ||
      !activity ||
      activity.phase !== "active" ||
      activity.source !== agent ||
      !Number.isFinite(activity.observedAt)
    )
      return null;
    return {
      session,
      panel,
      threadId,
      agent,
      state,
      activity,
      command: panel.activeCommand,
      paneId: panel.tmuxPaneId,
    };
  }
}
