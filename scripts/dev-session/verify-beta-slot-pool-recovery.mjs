import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

import {
  acquireBetaSlotLease,
  createBetaPoolRecoveryReceipt,
  finalizeBetaSlotRelease,
  inspectBetaSlotProcessSafety,
  inspectBetaPool,
  readBetaSlotMetadata,
  resolveBetaPoolPaths,
  runBetaPoolJanitor,
  runBetaPoolRecoveryPass,
} from "./beta-slot-pool.mjs";
import { resolveBetaUpdateTargets } from "../runweave-update-core.mjs";

export async function verifyBetaSlotPoolRecovery(temporaryHome, oldLease) {
  const candidateOrderHome = path.join(temporaryHome, "candidate-order-home");
  const candidateOrderApplications = path.join(
    temporaryHome,
    "candidate-order-applications",
  );
  const candidateOrderPaths = resolveBetaPoolPaths(candidateOrderHome);
  await Promise.all([
    fs.mkdir(candidateOrderPaths.leasesDir, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(candidateOrderApplications, { recursive: true }),
  ]);
  await Promise.all(
    [
      ["pool-01", "2000-01-01T00:00:00.000Z"],
      ["pool-02", "2000-01-02T00:00:00.000Z"],
    ].map(([slotId, acquiredAt]) =>
      fs.writeFile(
        path.join(candidateOrderPaths.leasesDir, `${slotId}.lock`),
        `${JSON.stringify({
          ...oldLease(slotId, `dvs-candidate-${slotId}`),
          acquiredAt,
        })}\n`,
        { mode: 0o600 },
      ),
    ),
  );
  const candidateOrderRecovery = await runBetaPoolRecoveryPass({
    strategy: "capacity_pressure",
    neededCapacity: 1,
    homeDir: candidateOrderHome,
    applicationsDir: candidateOrderApplications,
  });
  assert.deepEqual(
    candidateOrderRecovery.recovered.map((receipt) => receipt.slotId),
    ["pool-01"],
  );
  assert.deepEqual(
    candidateOrderRecovery.preserved.map((receipt) => receipt.slotId),
    ["pool-02"],
  );
  assert.equal(
    candidateOrderRecovery.preserved[0].selectionReason,
    "not-selected-capacity-already-satisfied",
  );
  assert.equal(
    candidateOrderRecovery.orderingReason,
    "recovery-cost-ascending, acquiredAt-ascending, slotId-ascending",
  );
  assert.deepEqual(
    candidateOrderRecovery.candidateOrder.map((entry) => ({
      slotId: entry.slotId,
      rank: entry.rank,
      result: entry.result,
    })),
    [
      { slotId: "pool-01", rank: 1, result: "recovered" },
      { slotId: "pool-02", rank: 2, result: "preserved" },
    ],
  );
  assert(
    (
      await fs.lstat(path.join(candidateOrderPaths.leasesDir, "pool-02.lock"))
    ).isFile(),
  );

  const receiptHome = path.join(temporaryHome, "receipt-home");
  const receiptApplications = path.join(
    temporaryHome,
    "receipt-applications",
  );
  const receiptManifestPath = path.join(
    receiptHome,
    "sessions",
    "dvs-receipt",
    "manifest.json",
  );
  await fs.mkdir(receiptApplications, { recursive: true });
  const receiptLease = await acquireBetaSlotLease({
    requestedSlotId: "pool-03",
    ownerSessionId: "dvs-receipt",
    ownerSourceRoot: process.cwd(),
    ownerRevision: "receipt-revision",
    ownerManifestPath: receiptManifestPath,
    homeDir: receiptHome,
  });
  const slotService = {
    ownership: "disabled",
    slotId: "pool-03",
    leaseNonce: receiptLease.lease.leaseNonce,
  };
  const receiptManifest = {
    schemaVersion: 1,
    devSessionId: "dvs-receipt",
    state: "stopping",
    profile: "beta",
    selectedBy: "explicit-profile",
    controlPlane: { appChannel: "stable" },
    targetEnvironment: {
      kind: "beta",
      acceptanceSurfaces: ["desktop"],
      instanceId: "pool-03",
      betaSlot: {
        policy: "fixed-pool-v1",
        capacity: 5,
        requestedSlotId: "pool-03",
        assignedSlotId: "pool-03",
        leaseNonce: receiptLease.lease.leaseNonce,
      },
    },
    source: {
      root: process.cwd(),
      revision: "receipt-revision",
      dirty: false,
    },
    services: {
      frontend: slotService,
      backend: slotService,
      appServer: slotService,
      electron: slotService,
      beta: slotService,
      cdp: { desktop: slotService, terminalBrowser: slotService },
    },
    impacts: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  await fs.mkdir(path.dirname(receiptManifestPath), { recursive: true });
  await fs.writeFile(
    receiptManifestPath,
    `${JSON.stringify(receiptManifest)}\n`,
    { mode: 0o600 },
  );
  const fixtureSecret = "beta-receipt-fixture-secret";
  const receiptTargets = resolveBetaUpdateTargets(receiptHome, "pool-03");
  await fs.mkdir(receiptTargets.userData, { recursive: true });
  await fs.writeFile(
    path.join(receiptTargets.userData, "auth-marker.json"),
    `${JSON.stringify({ Authorization: fixtureSecret, Cookie: fixtureSecret })}\n`,
  );
  const finalizedReceipt = await finalizeBetaSlotRelease({
    lease: receiptLease.lease,
    manifest: receiptManifest,
    receipt: createBetaPoolRecoveryReceipt({
      trigger: "explicit_recovery",
      initiatingSessionId: "dvs-receipt",
      slotId: "pool-03",
      ownerSessionId: "dvs-receipt",
      leaseNonce: receiptLease.lease.leaseNonce,
      previousManifestState: "stopping",
      previousDerivedState: "owned-stop",
    }),
    homeDir: receiptHome,
    applicationsDir: receiptApplications,
  });
  const [finalizedManifest, receiptMetadata, receiptProjection] =
    await Promise.all([
      fs.readFile(receiptManifestPath, "utf8").then(JSON.parse),
      readBetaSlotMetadata("pool-03", { homeDir: receiptHome }),
      inspectBetaPool({
        homeDir: receiptHome,
        applicationsDir: receiptApplications,
      }),
    ]);
  const receiptAttemptId = finalizedReceipt.receipt.attemptId;
  assert.equal(finalizedManifest.poolRecovery.attemptId, receiptAttemptId);
  assert.equal(
    receiptMetadata.lastRecoveryAttempt.attemptId,
    receiptAttemptId,
  );
  assert.equal(
    receiptProjection.slots.find((slot) => slot.slotId === "pool-03").metadata
      .lastRecoveryAttempt.attemptId,
    receiptAttemptId,
  );
  const serializedReceiptEvidence = JSON.stringify({
    output: finalizedReceipt.receipt,
    manifest: finalizedManifest,
    metadata: receiptMetadata,
    projection: receiptProjection,
  });
  assert(!serializedReceiptEvidence.includes(fixtureSecret));
  assert(!serializedReceiptEvidence.includes("Authorization"));
  assert(!serializedReceiptEvidence.includes("Cookie"));

  const recordedProcessHome = path.join(temporaryHome, "recorded-process-home");
  const recordedProcessApplications = path.join(
    temporaryHome,
    "recorded-process-applications",
  );
  const recordedProcessPaths = resolveBetaPoolPaths(recordedProcessHome);
  const recordedProcessTargets = resolveBetaUpdateTargets(
    recordedProcessHome,
    "pool-01",
  );
  const recordedProcessLeasePath = path.join(
    recordedProcessPaths.leasesDir,
    "pool-01.lock",
  );
  const recordedProcessMarkerPath = path.join(
    recordedProcessTargets.userData,
    "mutable-marker",
  );
  await Promise.all([
    fs.mkdir(recordedProcessPaths.leasesDir, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(recordedProcessTargets.userData, { recursive: true }),
    fs.mkdir(recordedProcessApplications, { recursive: true }),
  ]);
  await fs.writeFile(recordedProcessLeasePath, "{corrupt-json", {
    mode: 0o600,
  });
  await fs.writeFile(recordedProcessMarkerPath, "preserve\n");
  const recordedProcess = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  await fs.writeFile(
    path.join(recordedProcessTargets.userData, "beta-desktop-status.json"),
    `${JSON.stringify({ app: { pid: recordedProcess.pid } })}\n`,
  );
  const recordedProcessLeaseIdentity = await fs.lstat(recordedProcessLeasePath);
  try {
    const safety = await inspectBetaSlotProcessSafety(
      "pool-01",
      recordedProcessHome,
    );
    assert.equal(safety.recorded.desktop.active, true);
    assert.equal(safety.references.active, false);
    assert.deepEqual(safety.active, ["desktop"]);
    assert.equal(safety.safeToReset, false);
    const janitor = await runBetaPoolJanitor({
      homeDir: recordedProcessHome,
      applicationsDir: recordedProcessApplications,
    });
    assert.deepEqual(janitor.recovered, []);
    assert(
      janitor.broken.some(
        (entry) =>
          entry.slotId === "pool-01" && entry.reason === "active-desktop",
      ),
    );
    const preservedLeaseIdentity = await fs.lstat(recordedProcessLeasePath);
    assert.equal(preservedLeaseIdentity.dev, recordedProcessLeaseIdentity.dev);
    assert.equal(preservedLeaseIdentity.ino, recordedProcessLeaseIdentity.ino);
    assert((await fs.lstat(recordedProcessMarkerPath)).isFile());
  } finally {
    if (recordedProcess.exitCode === null) {
      recordedProcess.kill("SIGTERM");
      await once(recordedProcess, "exit");
    }
  }

  const corruptRecoveryHome = path.join(temporaryHome, "corrupt-recovery-home");
  const corruptRecoveryApplications = path.join(
    temporaryHome,
    "corrupt-recovery-applications",
  );
  const corruptRecoveryPaths = resolveBetaPoolPaths(corruptRecoveryHome);
  await Promise.all([
    fs.mkdir(corruptRecoveryPaths.leasesDir, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(corruptRecoveryApplications, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(corruptRecoveryPaths.leasesDir, "pool-01.lock"),
    "{corrupt-json",
    { mode: 0o600 },
  );
  const corruptRecovery = await runBetaPoolJanitor({
    homeDir: corruptRecoveryHome,
    applicationsDir: corruptRecoveryApplications,
  });
  assert.deepEqual(corruptRecovery.recovered, [
    { slotId: "pool-01", ownerSessionId: null },
  ]);
  assert.equal(
    await fs
      .lstat(path.join(corruptRecoveryPaths.leasesDir, "pool-01.lock"))
      .catch(() => null),
    null,
  );
  const quarantineOperations = await fs.readdir(
    corruptRecoveryPaths.quarantineDir,
  );
  assert.equal(quarantineOperations.length, 1);
  const quarantineReceipt = JSON.parse(
    await fs.readFile(
      path.join(
        corruptRecoveryPaths.quarantineDir,
        quarantineOperations[0],
        "operation.json",
      ),
      "utf8",
    ),
  ).receipt;
  assert.equal(quarantineReceipt.result, "recovered");
  assert.equal(quarantineReceipt.releasedLease, true);
  assert(quarantineReceipt.quarantinedLeasePath.endsWith("/lease.json"));

  const [cliSource, failedStartCleanupSource] = await Promise.all([
    fs.readFile(new URL("./cli.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("./cli-start-cleanup.mjs", import.meta.url), "utf8"),
  ]);
  const failedStartCleanupIndex = failedStartCleanupSource.indexOf(
    "async function cleanupFailedStart",
  );
  const failedStartClaimIndex = failedStartCleanupSource.indexOf(
    "await acquireBetaSlotRecoveryClaim",
    failedStartCleanupIndex,
  );
  const failedStartLockIndex = failedStartCleanupSource.indexOf(
    "await withSessionLock(sessionId",
    failedStartCleanupIndex,
  );
  const failedStartClaimBusyReturnIndex = failedStartCleanupSource.indexOf(
    "if (slotLease && !recoveryClaim)",
    failedStartClaimIndex,
  );
  const failedStartTerminalGuardIndex = failedStartCleanupSource.indexOf(
    "slotLease && !retainsBetaSlotLease(existing)",
    failedStartLockIndex,
  );
  const failedStartClaimReuseIndex = failedStartCleanupSource.indexOf(
    "claimAlreadyHeld: true",
    failedStartCleanupIndex,
  );
  const runStartIndex = cliSource.indexOf("async function runStart");
  const failedStartCleanupCallIndex = cliSource.indexOf(
    "await cleanupFailedStart",
    runStartIndex,
  );
  const poolRecoveryCandidateOrderIndex = cliSource.indexOf(
    "candidateOrder: []",
    runStartIndex,
  );
  const mergePoolRecoveryIndex = cliSource.indexOf(
    "const mergePoolRecovery",
    runStartIndex,
  );
  const mergeCandidateOrderIndex = cliSource.indexOf(
    "poolRecovery.candidateOrder.push",
    mergePoolRecoveryIndex,
  );
  const mergeOrderingReasonIndex = cliSource.indexOf(
    "poolRecovery.orderingReason = result.orderingReason",
    mergePoolRecoveryIndex,
  );
  const poolRecoveryOutputIndex = cliSource.indexOf(
    '...(plan.profile === "beta" ? { poolRecovery } : {})',
    runStartIndex,
  );
  assert(failedStartCleanupIndex >= 0);
  assert(failedStartClaimIndex > failedStartCleanupIndex);
  assert(failedStartClaimBusyReturnIndex > failedStartClaimIndex);
  assert(failedStartLockIndex > failedStartClaimBusyReturnIndex);
  assert(failedStartLockIndex > failedStartClaimIndex);
  assert(failedStartTerminalGuardIndex > failedStartLockIndex);
  assert(failedStartClaimReuseIndex > failedStartLockIndex);
  assert(failedStartCleanupCallIndex > runStartIndex);
  assert(poolRecoveryCandidateOrderIndex > runStartIndex);
  assert(mergeCandidateOrderIndex > mergePoolRecoveryIndex);
  assert(mergeOrderingReasonIndex > mergeCandidateOrderIndex);
  assert(poolRecoveryOutputIndex > mergeOrderingReasonIndex);
}
