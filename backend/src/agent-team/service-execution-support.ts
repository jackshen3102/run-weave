import type {
  AgentTeamPendingFindingDecision,
  AgentTeamRepairCycle,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";

export interface CreatedWorkerPanel {
  panelId: string;
  tmuxPaneId: string;
  paneRemoved?: boolean;
}

export function partialPanelFromError(
  error: AgentTeamError,
): CreatedWorkerPanel | null {
  if (!error.details || typeof error.details !== "object") {
    return null;
  }
  const details = error.details as Record<string, unknown>;
  const partialPanel = details.partialPanel;
  if (!partialPanel || typeof partialPanel !== "object") {
    return null;
  }
  const panel = partialPanel as Record<string, unknown>;
  if (
    typeof panel.panelId !== "string" ||
    typeof panel.tmuxPaneId !== "string"
  ) {
    return null;
  }
  return {
    panelId: panel.panelId,
    tmuxPaneId: panel.tmuxPaneId,
    paneRemoved: details.paneRemoved === true,
  };
}

export function pendingDecisionFromReviewCycle(
  cycles: AgentTeamRepairCycle[],
  reason: string,
): AgentTeamPendingFindingDecision | null {
  const cycle = cycles.find(
    (item) =>
      item.sourceRole === "code_review" && item.finding && item.reviewOutbox,
  );
  if (!cycle?.finding || !cycle.reviewOutbox) {
    return null;
  }
  return {
    id: [
      cycle.finding.invariantKey ?? cycle.repairKey,
      cycle.finding.reproduction?.scenarioId ?? "no-scenario",
      cycle.reviewTarget?.targetTree ?? "no-target",
    ].join(":"),
    finding: cycle.finding,
    outbox: cycle.reviewOutbox,
    reviewTarget: cycle.reviewTarget ?? null,
    reason,
    requestedAt: new Date().toISOString(),
  };
}
