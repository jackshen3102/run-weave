import type { AgentTeamActiveWorkerDispatch } from "./agent-team-dispatch";
import type { AgentTeamWorkerRole } from "./agent-team-worker";

export type AgentTeamFrameworkRepairResult = "blocked" | "continued" | "rerun";

export interface AgentTeamFrameworkRepairTarget {
  role: AgentTeamWorkerRole;
  caseIds: string[];
  panelId: string | null;
  tmuxPaneId: string | null;
  invalidatedDispatch: AgentTeamActiveWorkerDispatch;
}

/** Persisted framework-repair boundary. A blocked record revokes old dispatches. */
export interface AgentTeamFrameworkRepair {
  repairId: string;
  reason: string;
  begunAt: string;
  backendInstanceIdBefore: string;
  target: AgentTeamFrameworkRepairTarget;
  result: AgentTeamFrameworkRepairResult;
  /** A durable dispatch reservation which may already have reached the Worker. */
  pendingContinueDispatchId?: string | null;
  continuedAt?: string | null;
  continuedDispatchId?: string | null;
  rerunAt?: string | null;
  successorRunId?: string | null;
}
