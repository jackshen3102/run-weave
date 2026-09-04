import type { AgentTeamFrameworkRepairRecoveryStatus } from "./api";
import type {
  AgentTeamFindingDisposition,
  AgentTeamWorkerOutbox,
} from "./outbox";
import type { AgentTeamRun } from "./run";
import type { AgentTeamAcceptanceStatus } from "./run-contract";
import type { AgentTeamWorkerRole } from "./worker";

export type AgentTeamExportHistoryMode = "none" | "tail" | "full";

export interface AgentTeamExportPanel {
  panelId: string;
  tmuxPaneId: string | null;
  alias: string | null;
  role: string | null;
  workerRole: AgentTeamWorkerRole | "main" | "unknown";
  workerId: string | null;
  source: "main" | "worker" | "session-other";
  history?: {
    mode: "tail" | "full" | "unavailable";
    tailLines: number | null;
    scrollback: string | null;
    error?: string;
  };
}

export interface AgentTeamExportOutbox {
  path: string;
  exists: boolean;
  scope: "panel" | "tmux-pane" | "legacy-session";
  panelId: string | null;
  tmuxPaneId: string | null;
  outbox: AgentTeamWorkerOutbox | null;
  error?: string;
}

export interface AgentTeamOutboxHistoryRecord {
  schemaVersion: 1;
  runId: string;
  round: number;
  dispatchId: string;
  role: AgentTeamWorkerRole;
  panelId: string | null;
  tmuxPaneId: string | null;
  requestedAt: string;
  recordedAt: string;
  sourcePath: string;
  sourceMtimeMs: number;
  contentSha256: string;
  rawContent: string;
  outbox: AgentTeamWorkerOutbox;
}

export interface AgentTeamExportOutboxHistory {
  path: string;
  record: AgentTeamOutboxHistoryRecord | null;
  error?: string;
}

export interface AgentTeamExportAcceptanceSummary {
  caseId: string;
  status: AgentTeamAcceptanceStatus;
  evidenceCount: number;
  sourceRoles: string[];
  remainingFindingCount: number;
  resolvedFindingCount: number;
}

export interface AgentTeamFrameworkRepairResponse {
  run: AgentTeamRun;
  recovery: AgentTeamFrameworkRepairRecoveryStatus;
  successorRun: AgentTeamRun | null;
}

export interface DecideAgentTeamFindingRequest {
  invariantKey: string;
  disposition: AgentTeamFindingDisposition;
  caseIds?: string[];
  reason: string;
}

export interface AgentTeamFixtureScopeResponse {
  ownerRunId: string;
  ownerDispatchId: string | null;
  runs: AgentTeamRun[];
  ownedLiveFixtureRuns: number;
}

export interface CleanupAgentTeamFixtureScopeResponse extends AgentTeamFixtureScopeResponse {
  cancelledRunIds: string[];
  cleanupErrors: Array<{ runId: string; errors: string[] }>;
}

export interface AgentTeamExportResponse {
  run: AgentTeamRun;
  generatedAt: string;
  projectRoot: string | null;
  panels: {
    runBound: AgentTeamExportPanel[];
    sessionOther: AgentTeamExportPanel[];
  };
  outboxes: AgentTeamExportOutbox[];
  outboxHistory: AgentTeamExportOutboxHistory[];
  acceptanceSummary: AgentTeamExportAcceptanceSummary[];
  warnings: string[];
}

export interface AgentTeamRunsResponse {
  runs: AgentTeamRun[];
}
