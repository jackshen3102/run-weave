import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { verifyPlanner } from "./dev-session/verify-planner.mjs";
import { verifyBetaSlotPool } from "./dev-session/verify-beta-slot-pool.mjs";
import {
  verifyBackendProfileLockPublication,
  verifyLegacyBackendEnv,
  verifyRegistry,
  verifySafety,
} from "./dev-session/verify-registry.mjs";

async function main() {
  const temporaryHome = await mkdtemp(
    path.join(os.tmpdir(), "runweave-dev-session-"),
  );
  const sourceRoot = path.resolve(process.cwd());
  verifyPlanner(sourceRoot);
  await verifyBetaSlotPool(path.join(temporaryHome, "beta-slot-pool"));
  await verifyRegistry(sourceRoot, temporaryHome);
  await verifyBackendProfileLockPublication(sourceRoot, temporaryHome);
  verifySafety(temporaryHome);
  verifyLegacyBackendEnv();
  process.stdout.write(
    `${JSON.stringify({ ok: true, checks: ["planner", "beta-pool-projection-read-only", "beta-pool-allocator-diagnostic-only", "beta-pool-recorded-live-process-blocks-reset", "beta-start-failure-claim-before-session-lock", "beta-start-failure-claim-busy-preserves-manifest", "beta-pool-candidate-order-explanation", "beta-start-output-recovery-order-explanation", "beta-pool-corrupt-lease-quarantine", "beta-slot-dry-run-read-only", "beta-slot-capacity-5-of-6", "beta-slot-mutation-fixed-pool-only", "beta-slot-requested-fail-closed", "beta-slot-lease-owner-identity", "beta-slot-unknown-schema-fail-closed", "beta-slot-reset-barrier-retains-lease", "beta-slot-stale-orphan-identity-gated-recovery", "beta-slot-zero-process-stale-recovery", "beta-slot-single-owner-janitor-recovery", "beta-slot-current-previous-retention", "beta-slot-non-app-rollback-retention", "beta-slot-log-and-backup-retention", "beta-slot-mutable-reset-warm-preservation", "beta-slot-disk-budget-fail-closed", "beta-slot-legacy-quarantine-restore-confirmed-purge", "beta-slot-legacy-partial-cleanup", "beta-external-tmux-reference-non-owning", "beta-control-chain-classification", "profile-adapters", "impact-driven-ownership", "ownership-boundary", "legacy-env-compatibility", "manifest-permissions", "candidate-resolution", "stale-lock-recovery", "parallel-port-leases", "atomic-port-lease-publication", "stale-port-lease-aba", "partial-port-lease-fail-closed", "backend-profile-conflict-attribution", "atomic-backend-profile-lock", "stale-session-recovery-guidance", "stale-cleanup-retry-convergence", "failed-manifest-released-lease-lifecycle", "symlink-fail-closed", "status-stop-serialization", "stale-session-preservation", "newer-schema-fail-closed", "path-and-endpoint-safety"] })}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
