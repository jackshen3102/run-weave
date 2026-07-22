import type { AgentTeamAcceptanceObservation } from "./agent-team-run-contract";

export type AgentTeamAcceptanceSkipCode =
  | "blocked_by_case"
  | "fail_fast"
  | "environment"
  | "not_applicable";

export type AgentTeamEnvironmentBlockerScope = "case" | "run";

export interface AgentTeamAcceptanceSkip {
  code: AgentTeamAcceptanceSkipCode;
  blockerCaseIds?: string[];
  /** Stable identity for an environment blocker across repeated observations. */
  blockerFingerprint?: string;
  /** Whether resolving the blocker may invalidate only this case or the run. */
  blockerScope?: AgentTeamEnvironmentBlockerScope;
  retryable: boolean;
  detail: string;
}

export interface AgentTeamEnvironmentRecoveryProbeCase {
  caseId: string;
  observation: AgentTeamAcceptanceObservation;
  skip: AgentTeamAcceptanceSkip;
}

/** Snapshot captured before a representative environment-blocked case is retried. */
export interface AgentTeamEnvironmentRecoveryProbe {
  blockerFingerprint: string;
  blockerScope: "run";
  probeCases: AgentTeamEnvironmentRecoveryProbeCase[];
  affectedCaseIds: string[];
}

/** Audit record attached when an old environment observation is invalidated. */
export interface AgentTeamEnvironmentRecovery {
  blockerFingerprint: string;
  blockerScope: "run";
  resolvedAt: string;
  resolvedByCaseIds: string[];
  resolvedByDispatchId: string;
  invalidatedObservation: AgentTeamAcceptanceObservation | null;
  invalidatedSkip: AgentTeamAcceptanceSkip | null;
}

export interface AgentTeamAcceptanceDraft {
  caseId?: string | null;
  text: string;
  sourceCaseId?: string | null;
  sourceFilePath?: string | null;
  sourceHeading?: string | null;
  tags?: string[];
  dependsOn?: string[];
}
