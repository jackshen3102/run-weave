import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

import {
  BETA_SLOT_CAPACITY,
  inspectBetaPool,
  recoverBetaPoolSlot,
  resolveBetaPoolPaths,
} from "./beta-slot-pool.mjs";
import { readProcessSignature } from "./service-runtime.mjs";
import { resolveBetaUpdateTargets } from "../runweave-update-core.mjs";

export async function verifyBetaSlotPoolProjection(temporaryHome) {
  const paths = resolveBetaPoolPaths(temporaryHome);
  const emptyProjection = await inspectBetaPool({ homeDir: temporaryHome });
  assert.equal(emptyProjection.schemaVersion, 1);
  assert.equal(emptyProjection.reservationGuaranteed, false);
  assert.equal(emptyProjection.capacity, BETA_SLOT_CAPACITY);
  assert.equal(emptyProjection.summary.idle, BETA_SLOT_CAPACITY);
  assert.equal(await fs.lstat(paths.poolRoot).catch(() => null), null);

  const projectionHome = path.join(temporaryHome, "projection-home");
  const projectionPaths = resolveBetaPoolPaths(projectionHome);
  const projectionTargets = resolveBetaUpdateTargets(projectionHome, "pool-01");
  const projectionManifestPath = path.join(
    projectionHome,
    "sessions",
    "dvs-projection",
    "manifest.json",
  );
  const projectionLease = {
    schemaVersion: 1,
    slotId: "pool-01",
    leaseNonce: "projection-nonce",
    ownerSessionId: "dvs-projection",
    ownerSourceRoot: process.cwd(),
    ownerRevision: "projection-revision",
    ownerManifestPath: projectionManifestPath,
    allocatorPid: 99_999_999,
    acquiredAt: "2026-07-18T00:00:00.000Z",
  };
  await Promise.all([
    fs.mkdir(projectionPaths.leasesDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(path.dirname(projectionManifestPath), {
      recursive: true,
      mode: 0o700,
    }),
  ]);
  const projectionProcess = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", projectionTargets.instanceRoot],
    { stdio: "ignore" },
  );
  try {
    const slotService = (ownership, processInfo = undefined) => ({
      ownership,
      slotId: "pool-01",
      leaseNonce: projectionLease.leaseNonce,
      ...(processInfo ? { process: processInfo } : {}),
    });
    const processInfo = {
      pid: projectionProcess.pid,
      processSignature: readProcessSignature(projectionProcess.pid),
    };
    await Promise.all([
      fs.writeFile(
        path.join(projectionPaths.leasesDir, "pool-01.lock"),
        `${JSON.stringify(projectionLease)}\n`,
        { mode: 0o600 },
      ),
      fs.writeFile(
        projectionManifestPath,
        `${JSON.stringify({
          schemaVersion: 1,
          devSessionId: projectionLease.ownerSessionId,
          state: "ready",
          profile: "beta",
          controlPlane: { appChannel: "stable" },
          targetEnvironment: {
            kind: "beta",
            acceptanceSurfaces: ["desktop"],
            instanceId: "pool-01",
            betaSlot: {
              policy: "fixed-pool-v1",
              capacity: 5,
              requestedSlotId: null,
              assignedSlotId: "pool-01",
              leaseNonce: projectionLease.leaseNonce,
            },
          },
          source: {
            root: process.cwd(),
            revision: projectionLease.ownerRevision,
            dirty: false,
          },
          services: {
            frontend: slotService("dedicated", processInfo),
            backend: slotService("disabled"),
            appServer: slotService("disabled"),
            electron: slotService("disabled"),
            beta: slotService("dedicated", processInfo),
            cdp: {
              desktop: slotService("disabled"),
              terminalBrowser: slotService("disabled"),
            },
          },
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      ),
    ]);
    const projection = await inspectBetaPool({ homeDir: projectionHome });
    const projected = projection.slots.find(
      (slot) => slot.slotId === "pool-01",
    );
    assert.equal(projected.derivedState, "healthy");
    assert.equal(projected.lease.acquisition.processLive, false);
    assert.equal(projected.lease.acquisition.affectsRuntimeHealth, false);
    assert.equal(projected.runtime.ownedHealth, "healthy");

    const mismatchedManifest = JSON.parse(
      await fs.readFile(projectionManifestPath, "utf8"),
    );
    mismatchedManifest.services.beta.process.processSignature =
      "mismatched-process-signature";
    await fs.writeFile(
      projectionManifestPath,
      `${JSON.stringify(mismatchedManifest)}\n`,
      { mode: 0o600 },
    );
    const mismatchProjection = await inspectBetaPool({
      homeDir: projectionHome,
    });
    const mismatchSlot = mismatchProjection.slots.find(
      (slot) => slot.slotId === "pool-01",
    );
    assert.equal(mismatchSlot.derivedState, "stale-manual");
    assert.equal(
      mismatchSlot.recovery.code,
      "beta_pool_live_process_identity_mismatch",
    );
    assert.equal(mismatchSlot.recovery.expected.service, "beta");
    assert.equal(mismatchSlot.recovery.actual.pid, projectionProcess.pid);
    assert.equal(
      mismatchSlot.recovery.suggestedAction,
      "inspect-runtime-identity",
    );
    const mismatchReceipt = await recoverBetaPoolSlot({
      slotId: "pool-01",
      sessionId: projectionLease.ownerSessionId,
      homeDir: projectionHome,
    });
    assert.equal(mismatchReceipt.result, "preserved");
    assert.equal(mismatchReceipt.releasedLease, false);
    assert.equal(
      mismatchReceipt.code,
      "beta_pool_live_process_identity_mismatch",
    );
    assert.equal(mismatchReceipt.expected.service, "beta");
    assert.equal(mismatchReceipt.actual.pid, projectionProcess.pid);
    assert.equal(mismatchReceipt.suggestedAction, "inspect-runtime-identity");
    assert(
      (
        await fs.lstat(path.join(projectionPaths.leasesDir, "pool-01.lock"))
      ).isFile(),
    );
  } finally {
    if (projectionProcess.exitCode === null) {
      projectionProcess.kill("SIGTERM");
      await once(projectionProcess, "exit");
    }
  }
}
