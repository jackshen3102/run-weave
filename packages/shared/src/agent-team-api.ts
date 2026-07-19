import type { AgentTeamAcceptanceDraft } from "./agent-team-acceptance";
import type {
  AgentTeamRunKind,
  AgentTeamRunLineage,
} from "./agent-team-fixture";
import type {
  AgentTeamFrameworkRepairResult,
  AgentTeamFrameworkRepairTarget,
} from "./agent-team-framework-repair";
import type {
  AgentTeamAcceptanceDisposition,
  AgentTeamRunOptions,
  AgentTeamTerminal,
} from "./agent-team-run-contract";
import type { AgentTeamWorker } from "./agent-team-worker";

// --- request / response DTOs ---

export interface CreateAgentTeamRunRequest {
  projectId: string;
  terminalSessionId: string;
  runKind?: AgentTeamRunKind;
  lineage?: AgentTeamRunLineage | null;
  task?: string;
  planFilePath?: string | null;
  testCaseFilePath?: string | null;
  options?: Partial<AgentTeamRunOptions>;
  /**
   * Defaults to Codex for the current loop-engineer test path. Callers may
   * override this later without changing the orchestration flow.
   */
  terminal?: AgentTeamTerminal;
}

export interface ProposeAgentTeamSplitRequest {
  /** Who triggered the proposal: human button or agent self-judgment. */
  source?: "user" | "agent";
  summary?: string;
  workers?: Array<Pick<AgentTeamWorker, "role" | "intent">>;
  acceptance?: AgentTeamAcceptanceDraft[];
  planFilePath?: string | null;
  testCaseFilePath?: string | null;
  generatedTestCaseFilePath?: string | null;
}

export interface SubmitAgentTeamSplitGateRequest {
  verdict: "confirmed" | "rejected";
  workers?: Array<Pick<AgentTeamWorker, "role" | "intent">>;
  acceptance?: AgentTeamAcceptanceDraft[];
  planFilePath?: string | null;
  testCaseFilePath?: string | null;
  generatedTestCaseFilePath?: string | null;
}

export interface ResumeAgentTeamRunRequest {
  note: string;
}

export interface BeginAgentTeamFrameworkRepairRequest {
  reason: string;
}

export type AgentTeamFrameworkRepairContinueBlockerCode =
  | "backend_not_restarted"
  | "recovery_target_missing"
  | "worker_pane_unavailable"
  | "continue_dispatch_pending"
  | "repair_not_blocked";

export interface AgentTeamFrameworkRepairRecoveryStatus {
  runId: string;
  repairId: string;
  reason: string;
  result: AgentTeamFrameworkRepairResult;
  backendRestarted: boolean;
  canContinue: boolean;
  continueBlocker: {
    code: AgentTeamFrameworkRepairContinueBlockerCode;
    message: string;
  } | null;
  actions: Array<"continue" | "rerun">;
  target: AgentTeamFrameworkRepairTarget;
}

export interface CompleteAgentTeamRunRequest {
  note?: string;
}

export interface DecideAgentTeamAcceptanceRequest {
  caseId: string;
  disposition: AgentTeamAcceptanceDisposition;
  reason: string;
}

export interface FocusAgentTeamPaneRequest {
  panelId: string;
}
