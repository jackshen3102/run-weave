import type {
  AgentTeamConsumedWorkerDispatchReceipt,
  AgentTeamRun,
  AgentTeamWorker,
} from "@runweave/shared/agent-team";
import type { AgentTeamCompletionSignalSource } from "./service-types";
import { agentTeamLogger } from "./service-context";

export function logStaleCompletion(
  source: AgentTeamCompletionSignalSource,
  run: AgentTeamRun,
  worker: AgentTeamWorker,
  reason: string,
): void {
  const fields = {
    message: "Agent-team completion did not match the active dispatch",
    source,
    runId: run.runId,
    role: worker.role,
    panelId: worker.panelId ?? null,
    reason,
  };
  if (source === "watchdog") {
    agentTeamLogger.debug("agent-team.completion.stale", fields);
    return;
  }
  agentTeamLogger.info("agent-team.completion.stale", fields);
}

export function logConsumedCompletion(
  source: AgentTeamCompletionSignalSource,
  run: AgentTeamRun,
  receipt: AgentTeamConsumedWorkerDispatchReceipt,
): void {
  const fields = {
    message: "Agent-team completion matched an already consumed dispatch",
    source,
    runId: run.runId,
    role: receipt.role,
    dispatchId: receipt.dispatchId,
    reason: "outbox_dispatch_already_consumed",
  };
  if (source === "watchdog") {
    agentTeamLogger.debug("agent-team.completion.stale", fields);
    return;
  }
  agentTeamLogger.info("agent-team.completion.stale", fields);
}

export function logReconciledCompletion(
  source: AgentTeamCompletionSignalSource,
  run: AgentTeamRun,
  worker: AgentTeamWorker,
  outboxMtimeMs: number | null,
  resultCount: number,
): void {
  agentTeamLogger.info("agent-team.completion.reconciled", {
    message: "Agent-team completion reconciled from worker outbox",
    source,
    runId: run.runId,
    role: worker.role,
    panelId: worker.panelId ?? null,
    outboxMtimeMs,
    resultCount,
  });
}
