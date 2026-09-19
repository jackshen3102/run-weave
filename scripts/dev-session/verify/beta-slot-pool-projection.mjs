import { commitHealthyBetaUpdate } from "../../beta/restore-state.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

import {
  BETA_SLOT_CAPACITY,
  acquireBetaSlotLease,
  releaseBetaSlotLease,
  inspectAllocatableBetaSlotCapacity,
  inspectBetaPool,
  recoverBetaPoolSlot,
  resolveBetaPoolPaths,
} from "../beta-pool/index.mjs";
import { readProcessSignature } from "../services/runtime.mjs";
import {
  resolveBetaUpdateTargets,
  resolveBetaAppBackupPrefix,
} from "../../update/core.mjs";
import {
  collectBaseline,
  recordFailure,
  restoreBaseline,
} from "../../beta/operations.mjs";
import {
  getPathIdentity,
  readJson,
  resolveBetaPaths,
  writeJson,
} from "../../beta/state.mjs";
import {
  applyBetaSlotRetention,
  createBetaPoolRecoveryReceipt,
  recordBetaSlotRelease,
} from "../beta-pool/index.mjs";
import { repairBetaRetainedState } from "../beta-pool/recovery/retained-state.mjs";
import { createManifest } from "./registry.mjs";
import { writeManifest } from "../registry.mjs";

export async function verifyBetaSlotPoolProjection(temporaryHome) {
  const paths = resolveBetaPoolPaths(temporaryHome);
  const emptyApplications = path.join(temporaryHome, "empty-applications");
  const emptyProjection = await inspectBetaPool({
    homeDir: temporaryHome,
    applicationsDir: emptyApplications,
  });
  assert.equal(emptyProjection.schemaVersion, 1);
  assert.equal(emptyProjection.reservationGuaranteed, false);
  assert.equal(emptyProjection.capacity, BETA_SLOT_CAPACITY);
  assert.equal(emptyProjection.summary.idle, BETA_SLOT_CAPACITY);
  assert.equal(await fs.lstat(paths.poolRoot).catch(() => null), null);

  const brokenHome = path.join(temporaryHome, "broken-projection-home");
  const brokenApplications = path.join(
    temporaryHome,
    "broken-projection-applications",
  );
  const brokenTargets = resolveBetaUpdateTargets(brokenHome, "pool-03");
  await Promise.all([
    fs.mkdir(path.join(brokenTargets.runtimeHome, "releases", "current"), {
      recursive: true,
    }),
    fs.mkdir(path.dirname(brokenTargets.statePath), { recursive: true }),
    fs.mkdir(brokenApplications, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(brokenTargets.runtimeHome, "current.json"),
      `${JSON.stringify({ releaseId: "current" })}\n`,
    ),
    fs.writeFile(
      brokenTargets.statePath,
      `${JSON.stringify({
        previous: { runtimeReleaseId: "missing-previous" },
      })}\n`,
    ),
  ]);
  const brokenProjection = await inspectBetaPool({
    homeDir: brokenHome,
    applicationsDir: brokenApplications,
  });
  const brokenSlot = brokenProjection.slots.find(
    (slot) => slot.slotId === "pool-03",
  );
  assert.equal(brokenProjection.summary.idle, BETA_SLOT_CAPACITY - 1);
  assert.equal(brokenProjection.summary.broken, 1);
  assert.equal(brokenSlot.derivedState, "broken");
  assert.deepEqual(brokenSlot.reasons, ["retention-state-broken"]);
  assert.equal(brokenSlot.recovery.eligible, false);
  assert.equal(
    brokenSlot.recovery.blockedBy[0],
    "runtime pointer references a missing release",
  );
  const allocatable = await inspectAllocatableBetaSlotCapacity({
    homeDir: brokenHome,
    applicationsDir: brokenApplications,
  });
  assert.equal(allocatable.idle, BETA_SLOT_CAPACITY - 1);
  assert.equal(allocatable.broken, 1);
  assert.equal(
    allocatable.slots.find((slot) => slot.slotId === "pool-03").state,
    "broken",
  );

  const projectionHome = path.join(temporaryHome, "projection-home");
  const projectionApplications = path.join(
    temporaryHome,
    "projection-applications",
  );
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
    const projection = await inspectBetaPool({
      homeDir: projectionHome,
      applicationsDir: projectionApplications,
    });
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
      applicationsDir: projectionApplications,
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

export async function verifyBetaRestoredArtifacts(homeDir) {
  const slotId = "pool-02";
  const sourceRoot = process.cwd();
  const sessionId = "dvs-restore-artifacts";
  const applicationsDir = path.join(homeDir, "applications");
  const paths = resolveBetaPaths(sourceRoot, homeDir, slotId, sessionId);
  paths.appPath = path.join(applicationsDir, path.basename(paths.appPath));
  paths.appBackupPath = resolveBetaAppBackupPrefix(slotId, applicationsDir);
  const olderBackup = `${paths.appBackupPath}-1`;
  for (const dir of [
    paths.appPath,
    olderBackup,
    paths.logDir,
    ...[paths.runtimeHome, path.join(paths.appServerHome, "runtime")].flatMap(
      (root) =>
        ["current", "older"].map((release) =>
          path.join(root, "releases", release),
        ),
    ),
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(path.join(paths.appPath, "fixture"), "installed-baseline");
  await fs.writeFile(path.join(olderBackup, "fixture"), "older-generation");
  const source = {
    sourceRoot,
    gitHead: "verify",
    gitDirty: true,
    updatedAt: new Date().toISOString(),
  };
  const older = {
    app: {
      exists: true,
      backupPath: olderBackup,
      identity: await getPathIdentity(olderBackup),
      version: null,
    },
    runtimeReleaseId: "older",
    appServerReleaseId: "older",
    source: { ...source, gitHead: "older" },
  };
  await writeJson(paths.runtimeCurrentPath, { releaseId: "current" });
  await writeJson(paths.appServerCurrentPath, { releaseId: "current" });
  await writeJson(paths.statePath, {
    ...source,
    channel: "beta",
    mode: "app",
    previous: older,
  });
  const baseline = await collectBaseline(paths);
  baseline.app.backupPath = `${paths.appBackupPath}-2`;
  await fs.rename(paths.appPath, baseline.app.backupPath);
  await fs.mkdir(paths.appPath);
  await fs.writeFile(path.join(paths.appPath, "fixture"), "failed-install");
  await writeJson(paths.statePath, {
    ...source,
    gitHead: "attempt",
    mode: "app",
    previous: baseline,
  });
  await writeJson(paths.pendingPath, { baseline });
  await restoreBaseline(paths, baseline, { relaunch: false });
  const restored = await readJson(paths.statePath);
  assert.equal(await getPathIdentity(paths.appPath), baseline.app.identity);
  assert.equal(
    await fs.readFile(path.join(paths.appPath, "fixture"), "utf8"),
    "installed-baseline",
  );
  assert.equal(await fs.lstat(baseline.app.backupPath).catch(() => null), null);
  assert.equal(await fs.lstat(paths.pendingPath).catch(() => null), null);
  assert.equal(restored.previous.app.backupPath, olderBackup);
  assert.equal(restored.previous.source.gitHead, "older");
  assert.equal(restored.gitHead, "verify");
  await recordFailure(
    paths,
    baseline,
    path.join(paths.logDir, "failure.log"),
    "fixture startup failed",
    "attempt",
  );
  assert.deepEqual(
    (await readJson(paths.statePath)).previous,
    restored.previous,
  );
  await applyBetaSlotRetention({ slotId, homeDir, applicationsDir });

  // Accepted update prunes the older generation. Later standalone-style
  // rollback consumes its backup without recreating that pruned pointer.
  const committed = await collectBaseline(paths);
  committed.app.backupPath = `${paths.appBackupPath}-3`;
  await fs.rename(paths.appPath, committed.app.backupPath);
  await fs.mkdir(paths.appPath);
  await fs.writeFile(path.join(paths.appPath, "fixture"), "accepted-install");
  await commitHealthyBetaUpdate(
    paths,
    { ...source, mode: "app" },
    committed,
    null,
    { homeDir },
  );
  const committedBaseline = (await readJson(paths.statePath)).previous;
  assert.equal(await fs.lstat(olderBackup).catch(() => null), null);
  await restoreBaseline(paths, committedBaseline, {
    forceApp: true,
    relaunch: false,
  });
  assert.equal((await readJson(paths.statePath)).previous, null);
  await applyBetaSlotRetention({ slotId, homeDir, applicationsDir });
  const stateBeforeMissing = await fs.readFile(paths.statePath, "utf8");
  await assert.rejects(
    restoreBaseline(
      paths,
      { ...committed, app: { ...committed.app, identity: "wrong-inode" } },
      { forceApp: true, relaunch: false },
    ),
    /backup is missing/,
  );
  assert.equal(await fs.readFile(paths.statePath, "utf8"), stateBeforeMissing);

  // Legacy successful restore left a deleted prior backup reference. The
  // explicit repair must prove the exact released owner and installed inode.
  const failureAt = new Date().toISOString();
  const missingBackup = `${paths.appBackupPath}-4`;
  const previous = {
    ...committedBaseline,
    app: { ...committedBaseline.app, backupPath: missingBackup },
    priorAppBackupPath: missingBackup,
  };
  const logPath = path.join(paths.logDir, "legacy-failure.log");
  await fs.writeFile(
    logPath,
    "Beta update failed; recovery=automatic-restore-applied; fixture\n",
  );
  const legacyState = {
    ...(await readJson(paths.statePath)),
    previous,
    lastFailure: {
      at: failureAt,
      component: "beta-update",
      attemptedGitHead: "verify",
      logPath,
    },
  };
  await writeJson(paths.statePath, legacyState);
  const manifest = createManifest({ sourceRoot, sessionId });
  manifest.profile = "beta";
  manifest.state = "failed";
  manifest.createdAt = new Date(Date.parse(failureAt) - 1_000).toISOString();
  manifest.targetEnvironment = {
    kind: "beta",
    instanceId: slotId,
    acceptanceSurfaces: ["desktop"],
    betaSlot: {
      policy: "fixed-pool-v1",
      capacity: 5,
      requestedSlotId: null,
      assignedSlotId: slotId,
      leaseNonce: "restore-nonce",
    },
  };
  for (const service of [
    ...Object.values(manifest.services),
    ...Object.values(manifest.services.cdp),
  ]) {
    Object.assign(service, { slotId, leaseNonce: "restore-nonce" });
  }
  const release = createBetaPoolRecoveryReceipt({
    trigger: "start_failure",
    checks: { retentionFailed: "Beta app previous pointer is invalid" },
    slotId,
    ownerSessionId: sessionId,
    leaseNonce: "restore-nonce",
    releasedLease: true,
    result: "recovered",
    phase: "completed",
    completedAt: new Date().toISOString(),
  });
  manifest.poolRecovery = release;
  const env = {
    RUNWEAVE_DEV_SESSION_HOME: path.join(homeDir, ".runweave", "dev-sessions"),
  };
  await writeManifest(manifest, env);
  await recordBetaSlotRelease({
    slotId,
    revision: "verify",
    cleanupSummary: {},
    recoveryAttempt: release,
    homeDir,
  });
  const options = {
    slotId,
    sessionId,
    expectedFailureAt: failureAt,
    homeDir,
    applicationsDir,
    env,
  };
  const assertUnchangedRefusal = async (overrides = {}) => {
    const before = await fs.readFile(paths.statePath, "utf8");
    await assert.rejects(repairBetaRetainedState({ ...options, ...overrides }));
    assert.equal(await fs.readFile(paths.statePath, "utf8"), before);
  };
  await assertUnchangedRefusal({
    expectedFailureAt: new Date(Date.parse(failureAt) + 1).toISOString(),
  });
  const savedApp = path.join(applicationsDir, "saved-fixture");
  await fs.rename(paths.appPath, savedApp);
  await fs.mkdir(paths.appPath);
  await assertUnchangedRefusal();
  await fs.rmdir(paths.appPath);
  await fs.rename(savedApp, paths.appPath);
  const leasePath = path.join(
    resolveBetaPoolPaths(homeDir).leasesDir,
    `${slotId}.lock`,
  );
  await fs.mkdir(path.dirname(leasePath), { recursive: true });
  await fs.writeFile(leasePath, "{}");
  await assertUnchangedRefusal();
  await fs.rm(leasePath);
  const nextOwner = await acquireBetaSlotLease({
    requestedSlotId: slotId,
    ownerSessionId: "dvs-next-owner",
    ownerSourceRoot: process.cwd(),
    ownerRevision: "next-owner-revision",
    ownerManifestPath: path.join(homeDir, "next-owner-manifest.json"),
    homeDir,
  });
  try {
    await assertUnchangedRefusal();
    assert.equal((await readJson(nextOwner.leasePath)).leaseNonce, nextOwner.lease.leaseNonce);
  } finally {
    await releaseBetaSlotLease(nextOwner);
  }
  const metadataPath = path.join(
    resolveBetaPoolPaths(homeDir).metadataDir,
    `${slotId}.json`,
  );
  const metadata = await readJson(metadataPath);
  await writeJson(metadataPath, {
    ...metadata,
    lastRecoveryAttempt: {
      ...metadata.lastRecoveryAttempt,
      attemptId: "new-release",
    },
  });
  await assertUnchangedRefusal();
  await writeJson(metadataPath, metadata);
  await fs.symlink(paths.appPath, missingBackup);
  await assertUnchangedRefusal();
  await fs.rm(missingBackup);
  await writeJson(paths.statePath, {
    ...legacyState,
    lastFailure: {
      ...legacyState.lastFailure,
      at: new Date(Date.parse(failureAt) + 1).toISOString(),
    },
  });
  await assertUnchangedRefusal();
  await writeJson(paths.statePath, {
    ...legacyState,
    previous: {
      ...previous,
      app: {
        ...previous.app,
        backupPath: path.join(applicationsDir, "unknown"),
      },
    },
  });
  await assertUnchangedRefusal();
  await writeJson(paths.statePath, legacyState);
  const unknownBackup = `${paths.appBackupPath}-999`;
  await fs.mkdir(unknownBackup);
  await assertUnchangedRefusal();
  await fs.rmdir(unknownBackup);
  const receipt = await repairBetaRetainedState(options);
  assert.equal(receipt.result, "recovered");
  const repaired = await readJson(paths.statePath);
  assert.equal(repaired.previous.app.backupPath, null);
  assert.equal(
    repaired.retainedStateRepair.sourceReleaseAttemptId,
    release.attemptId,
  );
  delete repaired.retainedStateRepair;
  repaired.previous.app.backupPath = missingBackup;
  assert.deepEqual(repaired, legacyState);
  await applyBetaSlotRetention({ slotId, homeDir, applicationsDir });
  assert.equal(
    (await inspectBetaPool({ homeDir, applicationsDir })).slots.find(
      (slot) => slot.slotId === slotId,
    ).derivedState,
    "idle",
  );
}
