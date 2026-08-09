import type { AgentTeamAcceptanceSkip } from "./agent-team-acceptance";
import type { AgentTeamAcceptanceEvidence } from "./agent-team-evidence";
import type { AgentTeamReviewTarget } from "./agent-team-run-contract";

export type AgentTeamFindingVerificationMode = "runtime" | "structural";
export type AgentTeamOutboxStatus = "completed" | "failed";
export type AgentTeamFindingStatus = "open" | "resolved" | "informational";
export type AgentTeamFindingSeverity = "P0" | "P1" | "P2" | "P3";
export type AgentTeamFindingDisposition =
  | "blocking"
  | "out_of_scope"
  | "waived";

export interface AgentTeamFindingCaseImpact {
  caseId: string;
  summary: string;
  evidence: AgentTeamAcceptanceEvidence[];
}

export type AgentTeamFixReproductionMode =
  | "real_product"
  | "review_harness"
  | "static_contract";
export type AgentTeamFixReproductionStatus =
  | "reproduced"
  | "confirmed"
  | "not_reproduced"
  | "boundary"
  | "blocked";
export type AgentTeamFixCheckDimension =
  | "positive"
  | "negative"
  | "temporal"
  | "concurrent"
  | "regression";

export interface AgentTeamReviewFindingReproduction {
  mode: AgentTeamFixReproductionMode;
  status: AgentTeamFixReproductionStatus;
  scenarioId?: string | null;
  validationSessionId?: string | null;
  steps: string[];
  expected: string;
  actual: string;
  evidence: AgentTeamAcceptanceEvidence[];
}

export interface AgentTeamOutboxFinding {
  severity: AgentTeamFindingSeverity;
  status?: AgentTeamFindingStatus;
  title: string;
  summary: string;
  ref?: string;
  invariantKey?: string;
  verificationMode?: AgentTeamFindingVerificationMode;
  reproduction?: AgentTeamReviewFindingReproduction;
  disposition?: AgentTeamFindingDisposition;
  caseImpacts?: AgentTeamFindingCaseImpact[];
}

export interface AgentTeamFindingDecision {
  id: string;
  invariantKey: string;
  scenarioId: string | null;
  finding: AgentTeamOutboxFinding;
  disposition: AgentTeamFindingDisposition;
  caseIds: string[];
  reason: string;
  decidedAt: string;
  reviewTarget: AgentTeamReviewTarget | null;
}

export interface AgentTeamPendingFindingDecision {
  id: string;
  finding: AgentTeamOutboxFinding;
  outbox: AgentTeamWorkerOutbox;
  reviewTarget: AgentTeamReviewTarget | null;
  reason: string;
  requestedAt: string;
}

export interface AgentTeamFixVerification {
  repairKey: string;
  invariant: string;
  reproduction: {
    mode: AgentTeamFixReproductionMode;
    status: AgentTeamFixReproductionStatus;
    scenarioId?: string | null;
    validationSessionId?: string | null;
    evidence: AgentTeamAcceptanceEvidence[];
  };
  skillInvocation?: {
    name: "$toolkit:reproduce-before-fix";
    evidence: AgentTeamAcceptanceEvidence[];
  };
  verification: {
    status: "pass" | "fail" | "blocked";
    sameScenario: boolean;
    evidence: AgentTeamAcceptanceEvidence[];
  };
  impactedChecks: Array<{
    label: string;
    dimension: AgentTeamFixCheckDimension;
    status: "pass" | "fail" | "skipped";
    summary: string;
    evidence: AgentTeamAcceptanceEvidence[];
  }>;
  strategyAssessment?: string | null;
}

export interface AgentTeamOutboxRecommendation {
  severity?: AgentTeamFindingSeverity;
  summary: string;
}

export interface AgentTeamEvolutionFeedback {
  disposition: "adopted" | "ignored" | "conflicted";
  assetRevisionIds: string[];
  summary: string;
}

export interface AgentTeamWorkerOutbox {
  schemaVersion?: 1;
  dispatchId?: string | null;
  sessionId: string;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  projectId?: string | null;
  runId?: string | null;
  role?: string | null;
  status: AgentTeamOutboxStatus;
  summary: string;
  error: string | null;
  completionReason?: string | null;
  finishedAt: string;
  reviewTarget?: AgentTeamReviewTarget | null;
  verifiedCheckpointCommit?: string | null;
  findings?: AgentTeamOutboxFinding[];
  resolvedFindings?: AgentTeamOutboxFinding[];
  remainingFindings?: AgentTeamOutboxFinding[];
  recommendations?: AgentTeamOutboxRecommendation[];
  evolutionFeedback?: AgentTeamEvolutionFeedback | null;
  fixVerifications?: AgentTeamFixVerification[];
  acceptanceResults?: Array<{
    caseId: string;
    status: "pass" | "fail" | "skipped";
    summary?: string | null;
    skip?: AgentTeamAcceptanceSkip | null;
    skipReason?: string | null;
    evidence: AgentTeamAcceptanceEvidence[];
    reproduction?: AgentTeamReviewFindingReproduction;
  }>;
}
