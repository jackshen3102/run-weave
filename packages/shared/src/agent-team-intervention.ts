import type { AgentTeamWorkerRole } from "./agent-team-worker";

export type AgentTeamAgentInterventionAction =
  | "dispatch"
  | "refresh_acceptance";

export interface AgentTeamAgentIntervention {
  id: string;
  at: string;
  action: AgentTeamAgentInterventionAction;
  note: string;
  role: AgentTeamWorkerRole;
  caseIds: string[];
  previousReason: string | null;
  generatedTestCaseFilePath?: string | null;
  /** Exact dirty paths the main Agent accepted for this checkpoint dispatch. */
  checkpointAllowedDirtyPaths?: string[];
  /** Exact descendant HEAD the main Agent accepted for this behavior dispatch. */
  checkpointExpectedHeadCommit?: string;
  /** Rewritten checkpoint anchor accepted after a branch rebase. */
  checkpointRebasedCommit?: string;
}

export interface InterveneAgentTeamRunRequest {
  action: AgentTeamAgentInterventionAction;
  note: string;
  role: AgentTeamWorkerRole;
  caseIds?: string[];
  generatedTestCaseFilePath?: string | null;
  checkpointAllowedDirtyPaths?: string[];
  checkpointExpectedHeadCommit?: string;
  checkpointRebasedCommit?: string;
}
