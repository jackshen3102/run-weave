import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { verifyPlanner } from "./dev-session/verify-planner.mjs";
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
  await verifyRegistry(sourceRoot, temporaryHome);
  await verifyBackendProfileLockPublication(sourceRoot, temporaryHome);
  verifySafety(temporaryHome);
  verifyLegacyBackendEnv();
  process.stdout.write(
    `${JSON.stringify({ ok: true, checks: ["planner", "beta-control-chain-classification", "profile-adapters", "impact-driven-ownership", "ownership-boundary", "legacy-env-compatibility", "manifest-permissions", "candidate-resolution", "stale-lock-recovery", "parallel-port-leases", "atomic-port-lease-publication", "stale-port-lease-aba", "partial-port-lease-fail-closed", "backend-profile-conflict-attribution", "atomic-backend-profile-lock", "stale-session-recovery-guidance", "stale-cleanup-retry-convergence", "symlink-fail-closed", "status-stop-serialization", "stale-session-preservation", "newer-schema-fail-closed", "path-and-endpoint-safety"] })}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
