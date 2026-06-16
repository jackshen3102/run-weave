import type { TerminalRuntimePreference } from "./terminal-protocol";

export type OrchestratorRunStatus =
  | "running"
  | "paused"
  | "need_human"
  | "done"
  | "failed";

export type OrchestratorGoalStatus =
  | "pending"
  | "running"
  | "done"
  | "blocked"
  | "failed";

export type OrchestratorOutboxStatus = "completed" | "failed";

export interface OrchestratorRoleDefinition {
  id: string;
  name: string;
  terminal: {
    command?: string;
    args?: string[];
    cwd?: string | null;
    runtimePreference?: TerminalRuntimePreference;
  };
  prompt: string;
}

export interface OrchestratorTerminalBinding {
  mode: "new" | "reuse";
  sessionId?: string | null;
}

export interface OrchestratorRunRole {
  id: string;
  name: string;
  binding: OrchestratorTerminalBinding;
  terminal: OrchestratorRoleDefinition["terminal"];
  prompt: string;
}

export interface OrchestratorRunAgent {
  role: "orchestrator";
  binding: OrchestratorTerminalBinding;
  sessionId?: string | null;
  startupPrompt: string;
  terminal: OrchestratorRoleDefinition["terminal"];
}

export interface OrchestratorWorkerOutbox {
  sessionId: string;
  projectId?: string | null;
  runId?: string | null;
  role?: string | null;
  goalId?: string | null;
  status: OrchestratorOutboxStatus;
  summary: string;
  artifacts: Array<{ type: "file"; path: string }>;
  error: string | null;
  completionReason?: string | null;
  finishedAt: string;
}

export interface OrchestratorGoal {
  id: string;
  desc: string;
  deps: string[];
  status: OrchestratorGoalStatus;
  assignedRole?: string | null;
  sessionId?: string | null;
  result?: OrchestratorWorkerOutbox | null;
  attempts: number;
}

export interface OrchestratorTimelineItem {
  id: string;
  type: "run_created" | "dispatch" | "worker_result" | "direct_send" | "human";
  at: string;
  title: string;
  detail?: string;
  goalId?: string | null;
  roleId?: string | null;
  terminalSessionId?: string | null;
}

export interface OrchestratorRunPackage {
  runId: string;
  projectId: string;
  task: string;
  status: OrchestratorRunStatus;
  orchestrator: OrchestratorRunAgent;
  roles: OrchestratorRunRole[];
  goals: OrchestratorGoal[];
  humanInbox: Array<{ id: string; at: string; text: string }>;
  timeline: OrchestratorTimelineItem[];
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorDispatchSidecar {
  sessionId: string;
  role: string;
  goalId: string;
  runId: string;
  dispatchedAt: string;
}

export interface CreateOrchestratorRunRequest {
  runId?: string;
  projectId: string;
  task: string;
  orchestrator: Omit<OrchestratorRunAgent, "role" | "sessionId"> & {
    role?: "orchestrator";
  };
  roles: OrchestratorRunRole[];
}

export interface PreviewOrchestratorRunPromptResponse {
  runId: string;
  prompt: string;
}

export interface DispatchOrchestratorGoalRequest {
  runId: string;
  roleId: string;
  goalId: string;
  query: string;
  desc?: string;
  sessionId?: string | null;
  newSession?: boolean;
}

export interface InjectOrchestratorPromptRequest {
  text: string;
}

export interface OrchestratorRolesResponse {
  roles: OrchestratorRoleDefinition[];
}

export interface OrchestratorRunsResponse {
  runs: OrchestratorRunPackage[];
}
