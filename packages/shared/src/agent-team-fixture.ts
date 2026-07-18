export type AgentTeamRunKind = "primary" | "verification_fixture";

export interface AgentTeamRunLineage {
  /** Stable owner on the parent control plane. */
  ownerRunId: string;
  /** Exact behavior_verify dispatch that created this fixture. */
  ownerDispatchId: string;
  /** Product cases covered by the owning behavior dispatch. */
  ownerCaseIds: string[];
  /** Dev Session that bridges the parent and fixture control planes. */
  ownerDevSessionId?: string | null;
  /** Auditable namespace shared by resources from the same fixture scope. */
  fixtureNamespace: string;
  /** Only exclusive fixture sessions may be destroyed by cleanup. */
  ownsTerminalSession: boolean;
  cleanupPolicy: "on_owner_dispatch_complete" | "on_owner_run_complete";
}

export interface AgentTeamRunCancellation {
  reason: string;
  requestedAt: string;
  source: "api" | "owner_cleanup";
}

export interface AgentTeamFixtureResourceCleanup {
  status: "completed" | "failed";
  attemptedAt: string;
  completedAt: string | null;
  terminalSessionId: string;
  terminalSessionDestroyed: boolean;
  cleanedPanelIds: string[];
  preservedTerminalSession: boolean;
  errors: string[];
}

export interface AgentTeamFixtureDevSessionCleanup {
  devSessionId: string;
  state: string;
  cleanupStatus: string | null;
  ownedLiveFixtureRuns: number | null;
  resourceLedger: AgentTeamFixtureResourceLedger | null;
  error: string | null;
}

export interface AgentTeamFixtureResourceLedger {
  devSessionId: string;
  runIds: string[];
  terminalSessionIds: string[];
  panelIds: string[];
  outboxIds: string[];
}

export interface AgentTeamOwnedFixtureCleanup {
  ownerDispatchId: string | null;
  requestedAt: string;
  completedAt: string | null;
  status: "completed" | "blocked";
  ownedRunIds: string[];
  cancelledRunIds: string[];
  ownedLiveFixtureRunIds: string[];
  devSessions: AgentTeamFixtureDevSessionCleanup[];
  errors: string[];
}

export interface CancelAgentTeamRunRequest {
  reason: string;
  cleanupResources?: boolean;
}

export interface CleanupAgentTeamFixtureScopeRequest {
  ownerRunId: string;
  ownerDispatchId?: string | null;
  reason: string;
}
