import type { AgentTeamReviewTarget } from "./agent-team-run-contract";
import type { AgentTeamWorkerRole } from "./agent-team-worker";
import type { AgentTeamEnvironmentRecoveryProbe } from "./agent-team-acceptance";

/** Persisted freshness boundary for the worker currently allowed to complete. */
export interface AgentTeamActiveWorkerDispatch {
  /** Unique identity for this backend-owned dispatch. */
  dispatchId?: string;
  /** Absent on persisted legacy dispatches whose worker prompt had no dispatch id. */
  outboxDispatchIdRequired?: boolean;
  role: AgentTeamWorkerRole;
  panelId: string | null;
  tmuxPaneId: string | null;
  /** Loop round at dispatch time; absent on runs persisted before round attribution. */
  round?: number;
  requestedAt: string;
  /** null means the pane-scoped outbox did not exist when work was dispatched. */
  outboxMtimeMs: number | null;
  reviewTarget?: AgentTeamReviewTarget | null;
  /** Commit the behavior worker must verify for this exact dispatch. */
  verifiedCheckpointCommit?: string | null;
  /** Exact dirty paths accepted for this exact behavior dispatch. */
  checkpointAllowedDirtyPaths?: string[];
  /** Rewritten checkpoint commit whose trailers match the persisted checkpoint. */
  checkpointRebasedCommit?: string | null;
  /** Backend-owned repair identities expected from a bounced code worker. */
  repairKeys?: string[];
  /** Run-scoped environment blocker being re-probed by this dispatch. */
  environmentRecoveryProbe?: AgentTeamEnvironmentRecoveryProbe | null;
  /** One protocol-only correction is allowed before escalating to a human. */
  protocolCorrectionAttempt?: number;
  /** Source snapshot captured before a protocol-only outbox correction. */
  protocolCorrectionSourceFingerprint?: AgentTeamSourceFingerprint | null;
}

export interface AgentTeamSourceFingerprint {
  repoRoot: string;
  sha256: string;
}

export interface AgentTeamConsumedWorkerDispatchReceipt {
  dispatchId: string;
  role: AgentTeamWorkerRole;
  round: number;
  contentSha256: string;
  consumedAt: string;
}
