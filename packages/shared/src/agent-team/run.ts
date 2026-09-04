import type {
  AgentTeamAcceptanceSkip,
  AgentTeamEnvironmentRecovery,
} from "./acceptance";
import type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamConsumedWorkerDispatchReceipt,
} from "./dispatch";
import type { AgentTeamAcceptanceEvidence } from "./evidence";
import type {
  AgentTeamFixtureResourceCleanup,
  AgentTeamOwnedFixtureCleanup,
  AgentTeamRunCancellation,
  AgentTeamRunKind,
  AgentTeamRunLineage,
} from "./fixture";
import type { AgentTeamFrameworkRepair } from "./framework-repair";
import type { AgentTeamAgentIntervention } from "./intervention";
import type {
  AgentTeamFindingDecision,
  AgentTeamFindingVerificationMode,
  AgentTeamOutboxFinding,
  AgentTeamPendingFindingDecision,
  AgentTeamReviewFindingReproduction,
  AgentTeamWorkerOutbox,
} from "./outbox";
import type {
  AgentTeamAcceptanceDisposition,
  AgentTeamAcceptanceObservation,
  AgentTeamAcceptanceObservedOutcome,
  AgentTeamAcceptanceStatus,
  AgentTeamCompletionOutcome,
  AgentTeamPhase,
  AgentTeamReviewCheckpointState,
  AgentTeamReviewTarget,
  AgentTeamRunOptions,
  AgentTeamStatus,
  AgentTeamTerminal,
  AgentTeamVerificationConfig,
} from "./run-contract";
import type { AgentTeamWorker, AgentTeamWorkerRole } from "./worker";

export interface AgentTeamAcceptanceCase {
  caseId: string;
  text: string;
  sourceCaseId?: string | null;
  sourceFilePath?: string | null;
  sourceHeading?: string | null;
  tags?: string[];
  dependsOn?: string[];
  lastRunStatus?: "pass" | "fail" | "skipped" | "pending";
  latestObservation?: AgentTeamAcceptanceObservation | null;
  skip?: AgentTeamAcceptanceSkip | null;
  skipReason?: string | null;
  environmentRecovery?: AgentTeamEnvironmentRecovery | null;
  resultSummary?: string | null;
  reproduction?: AgentTeamReviewFindingReproduction | null;
  status: AgentTeamAcceptanceStatus;
  consecutiveFail: number;
  evidence: AgentTeamAcceptanceEvidence[];
  bouncedToPanelId?: string | null;
  recheckRequestedAt?: string | null;
  recheckDispatchId?: string | null;
  recheckWorkerPanelId?: string | null;
  recheckWorkerRole?: AgentTeamWorkerRole | null;
  recheckOutboxMtimeMs?: number | null;
  recheckAttempt?: number;
}

export interface AgentTeamAcceptanceDecision {
  id: string;
  caseId: string;
  disposition: AgentTeamAcceptanceDisposition;
  reason: string;
  observation: AgentTeamAcceptanceObservation;
  decidedAt: string;
}

export function resolveAgentTeamAcceptanceObservedOutcome(
  item: AgentTeamAcceptanceCase,
): AgentTeamAcceptanceObservedOutcome | "pending" {
  if (item.latestObservation) {
    return item.latestObservation.outcome;
  }
  if (item.lastRunStatus === "skipped" || item.skip) {
    return "skipped";
  }
  if (item.lastRunStatus === "pass" || item.status === "pass") {
    return "pass";
  }
  if (item.lastRunStatus === "fail" || item.status === "fail") {
    return "fail";
  }
  return "pending";
}

export interface AgentTeamRepairCycle {
  repairKey: string;
  sourceRole: "code_review" | "behavior_verify";
  caseIds: string[];
  invariant: string;
  verificationMode: AgentTeamFindingVerificationMode;
  sourceEvidenceRefs?: string[];
  sourceReproduction?: AgentTeamReviewFindingReproduction;
  attempts: number;
  maxAttempts: number;
  firstFailedRound: number;
  lastFailedRound: number;
  lastFailureSummary: string;
  finding?: AgentTeamOutboxFinding;
  reviewTarget?: AgentTeamReviewTarget | null;
  reviewOutbox?: AgentTeamWorkerOutbox;
}

export interface AgentTeamLoop {
  round: number;
  noProgressCount: number;
  maxNoProgress: number;
  escalated: boolean;
  lastReason: string | null;
  stableFailThreshold: number;
  errorFingerprints: string[];
  bestPassCount: number;
  repairCycles: AgentTeamRepairCycle[];
  maxRepairAttempts: number;
}

export interface AgentTeamProposal {
  summary: string;
  workers: AgentTeamWorker[];
  acceptance: AgentTeamAcceptanceCase[];
  source: "user" | "agent";
}

export interface AgentTeamClarifyMessage {
  from: "agent" | "human";
  text: string;
  at: string;
}

export interface HumanInterventionNote {
  id: string;
  at: string;
  text: string;
  clearedFingerprints: string[];
  clearedRepairCycles?: AgentTeamRepairCycle[];
}

export interface AgentTeamRun {
  runId: string;
  projectId: string;
  runKind?: AgentTeamRunKind;
  lineage?: AgentTeamRunLineage | null;
  terminalSessionId: string;
  mainPanelId?: string | null;
  phase: AgentTeamPhase;
  status: AgentTeamStatus;
  options: AgentTeamRunOptions;
  terminal: AgentTeamTerminal;
  roleRuntimes?: import("./model-config").AgentTeamRoleRuntimeSnapshot;
  retryOfRunId?: string | null;
  task: string;
  verification?: AgentTeamVerificationConfig | null;
  reviewCheckpoint?: AgentTeamReviewCheckpointState | null;
  activeWorkerRole?: AgentTeamWorkerRole | null;
  activeWorkerDispatch?: AgentTeamActiveWorkerDispatch | null;
  workerDispatchProtocolVersion?: 1;
  consumedWorkerDispatches?: AgentTeamConsumedWorkerDispatchReceipt[];
  frameworkRepair?: AgentTeamFrameworkRepair | null;
  predecessorRunId?: string | null;
  successorRunId?: string | null;
  clarify: AgentTeamClarifyMessage[];
  proposal: AgentTeamProposal | null;
  workers: AgentTeamWorker[];
  acceptance: AgentTeamAcceptanceCase[];
  acceptanceDecisions?: AgentTeamAcceptanceDecision[];
  completionOutcome?: AgentTeamCompletionOutcome | null;
  completionHistory?: AgentTeamCompletionOutcome[];
  loop: AgentTeamLoop;
  humanNotes: HumanInterventionNote[];
  agentInterventions?: AgentTeamAgentIntervention[];
  findingDecisions?: AgentTeamFindingDecision[];
  pendingFindingDecision?: AgentTeamPendingFindingDecision | null;
  cancellation?: AgentTeamRunCancellation | null;
  fixtureResourceCleanup?: AgentTeamFixtureResourceCleanup | null;
  fixtureCleanupHistory?: AgentTeamOwnedFixtureCleanup[];
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

export function resolveAgentTeamAcceptanceDecision(
  run: AgentTeamRun,
  item: AgentTeamAcceptanceCase,
): AgentTeamAcceptanceDecision | null {
  const observation = item.latestObservation;
  if (!observation) {
    return null;
  }
  return (
    (run.acceptanceDecisions ?? [])
      .slice()
      .reverse()
      .find(
        (decision) =>
          decision.caseId === item.caseId &&
          decision.observation.outcome === observation.outcome &&
          decision.observation.dispatchId === observation.dispatchId &&
          decision.observation.recordedAt === observation.recordedAt,
      ) ?? null
  );
}
