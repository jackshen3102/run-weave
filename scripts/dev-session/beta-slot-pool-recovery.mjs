import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { DevSessionError, validateManifest } from "./contracts.mjs";
import { withSessionLock } from "./registry.mjs";
import { processIdentityMatches } from "./service-runtime.mjs";
import { stopOwnedProcess } from "./shared-services.mjs";
import {
  acquireBetaSlotRecoveryClaim,
  assertBetaSlotId,
  assertBetaSlotLease,
  atomicWriteJson,
  isPidLive,
  readRegularJson,
  releaseBetaSlotRecoveryClaim,
  resolveBetaPoolPaths,
  sameFileIdentity,
} from "./beta-slot-pool-core.mjs";
import { assertBetaPoolStorageReadyForExistingLease } from "./beta-slot-pool-storage-migration.mjs";
import {
  createBetaPoolRecoveryReceipt,
  finalizeBetaSlotRelease,
} from "./beta-slot-pool-lifecycle.mjs";
import { inspectBetaSlotProcessSafety } from "./beta-slot-pool-process-inspection.mjs";
import { inspectBetaPool } from "./beta-slot-pool-projection.mjs";
import {
  applyBetaSlotRetention,
  recordBetaSlotRecoveryAttempt,
  resetBetaSlotMutableState,
} from "./beta-slot-pool-storage.mjs";

const execFileAsync = promisify(execFile);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLease(slotId, paths, homeDir) {
  const raw = await readRegularJson(
    path.join(paths.leasesDir, `${slotId}.lock`),
    paths.poolRoot,
  );
  const ownerSessionId = raw.value?.ownerSessionId;
  const leaseNonce = raw.value?.leaseNonce;
  if (typeof ownerSessionId !== "string" || typeof leaseNonce !== "string") {
    return { corrupt: true, stats: raw.stats, value: null };
  }
  return {
    corrupt: false,
    ...(await assertBetaSlotLease({
      slotId,
      ownerSessionId,
      leaseNonce,
      homeDir,
    })),
  };
}

async function readOwnerManifest(lease) {
  try {
    return validateManifest(
      (
        await readRegularJson(
          lease.ownerManifestPath,
          path.dirname(lease.ownerManifestPath),
        )
      ).value,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function stopRecordedDedicatedServices(manifest, lease, homeDir) {
  const stoppedServices = [];
  const dedicatedServices = Object.entries(manifest.services ?? {}).filter(
    ([name, service]) => name !== "cdp" && service?.ownership === "dedicated",
  );
  for (const [name, service] of dedicatedServices) {
    if (
      isPidLive(service.process?.pid) &&
      !processIdentityMatches(service.process)
    ) {
      throw new DevSessionError(
        "Beta recovery found a reused or identity-drifted PID",
        5,
        {
          code: "beta_pool_live_process_identity_mismatch",
          slotId: lease.slotId,
          service: name,
          pid: service.process.pid,
        },
      );
    }
  }
  const sourceRoot = manifest.source?.root;
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    throw new DevSessionError(
      "Beta recovery manifest source root is invalid",
      5,
      {
        slotId: lease.slotId,
      },
    );
  }
  const controlScript = path.join(sourceRoot, "scripts", "runweave-beta.mjs");
  if (await fs.lstat(controlScript).catch(() => null)) {
    try {
      await execFileAsync(
        process.execPath,
        [
          controlScript,
          "stop",
          "--instance",
          lease.slotId,
          "--dev-session",
          lease.ownerSessionId,
        ],
        { cwd: sourceRoot, encoding: "utf8", timeout: 60_000 },
      );
    } catch {
      // control script stop failed; fall through to direct process kill
    }
  }
  for (const [name, service] of dedicatedServices) {
    if (isPidLive(service.process?.pid)) {
      await stopOwnedProcess(service.process);
      stoppedServices.push(name);
    }
  }
  const safety = await inspectBetaSlotProcessSafety(lease.slotId, homeDir);
  if (!safety.safeToReset) {
    throw new DevSessionError(
      "Beta recovery found slot processes after dedicated service cleanup",
      5,
      { slotId: lease.slotId, safety },
    );
  }
  return stoppedServices;
}

function ownerSessionLockEnv(lease) {
  const sessionDir = path.dirname(lease.ownerManifestPath);
  if (
    path.basename(lease.ownerManifestPath) !== "manifest.json" ||
    path.basename(sessionDir) !== lease.ownerSessionId
  ) {
    return null;
  }
  return {
    ...process.env,
    RUNWEAVE_DEV_SESSION_HOME: path.dirname(sessionDir),
  };
}

async function persistNonMutatingReceipt(receipt, homeDir) {
  await recordBetaSlotRecoveryAttempt({
    slotId: receipt.slotId,
    attempt: receipt,
    homeDir,
  });
  return receipt;
}

async function quarantineCorruptLease({
  slot,
  trigger,
  initiatingSessionId,
  homeDir,
  applicationsDir,
  paths,
}) {
  const leasePath = path.join(paths.leasesDir, `${slot.slotId}.lock`);
  const initialStats = await fs.lstat(leasePath).catch(() => null);
  let leaseQuarantined = false;
  let quarantinedLeasePath = null;
  const base = createBetaPoolRecoveryReceipt({
    trigger,
    initiatingSessionId,
    slotId: slot.slotId,
    previousDerivedState: slot.derivedState,
    checks: slot.recovery.checks,
  });
  const safety = await inspectBetaSlotProcessSafety(slot.slotId, homeDir);
  if (
    !initialStats ||
    initialStats.isSymbolicLink() ||
    !initialStats.isFile() ||
    !safety.safeToReset
  ) {
    return await persistNonMutatingReceipt(
      {
        ...base,
        completedAt: new Date().toISOString(),
        result: "blocked",
        blockedBy: [
          ...(initialStats && !initialStats.isSymbolicLink()
            ? []
            : ["lease-file-identity-unsafe"]),
          ...safety.unknown,
          ...safety.active.map((name) => `active-${name}`),
        ],
      },
      homeDir,
    );
  }
  try {
    const reset = await resetBetaSlotMutableState({
      slotId: slot.slotId,
      homeDir,
    });
    const retention = await applyBetaSlotRetention({
      slotId: slot.slotId,
      homeDir,
      applicationsDir,
    });
    const secondSafety = await inspectBetaSlotProcessSafety(
      slot.slotId,
      homeDir,
    );
    const currentStats = await fs.lstat(leasePath);
    if (
      !secondSafety.safeToReset ||
      !sameFileIdentity(initialStats, currentStats)
    ) {
      throw new DevSessionError(
        "corrupt Beta lease safety changed before quarantine",
        5,
        { slotId: slot.slotId },
      );
    }
    const operationId = randomUUID();
    const operationDir = path.join(paths.quarantineDir, operationId);
    await fs.mkdir(operationDir, { recursive: true, mode: 0o700 });
    quarantinedLeasePath = path.join(operationDir, "lease.json");
    const pending = {
      ...base,
      phase: "release_pending",
      result: "recovered",
      checks: { ...base.checks, slotProcessesAbsent: true },
    };
    await recordBetaSlotRecoveryAttempt({
      slotId: slot.slotId,
      attempt: pending,
      homeDir,
    });
    await atomicWriteJson(
      path.join(operationDir, "operation.json"),
      { receipt: pending, cleanupSummary: { ...reset, retention } },
      paths.quarantineDir,
    );
    await fs.rename(leasePath, quarantinedLeasePath);
    leaseQuarantined = true;
    const completed = {
      ...pending,
      completedAt: new Date().toISOString(),
      phase: "completed",
      releasedLease: true,
      quarantinedLeasePath,
    };
    await atomicWriteJson(
      path.join(operationDir, "operation.json"),
      { receipt: completed, cleanupSummary: { ...reset, retention } },
      paths.quarantineDir,
    );
    await recordBetaSlotRecoveryAttempt({
      slotId: slot.slotId,
      attempt: completed,
      homeDir,
    });
    return completed;
  } catch (error) {
    if (leaseQuarantined) {
      const releasedPending = {
        ...base,
        result: "recovered",
        phase: "release_pending",
        releasedLease: true,
        quarantinedLeasePath,
        failureReason: error instanceof Error ? error.message : String(error),
      };
      await recordBetaSlotRecoveryAttempt({
        slotId: slot.slotId,
        attempt: releasedPending,
        homeDir,
      }).catch(() => undefined);
      return releasedPending;
    }
    const failed = {
      ...base,
      completedAt: new Date().toISOString(),
      result: "failed",
      failureReason: error instanceof Error ? error.message : String(error),
      blockedBy: ["lease-retained"],
    };
    await recordBetaSlotRecoveryAttempt({
      slotId: slot.slotId,
      attempt: failed,
      homeDir,
    }).catch(() => undefined);
    return failed;
  }
}

async function recoverValidLease({
  slot,
  trigger,
  initiatingSessionId,
  expectedSessionId,
  strategy,
  secondCheckDelayMs,
  homeDir,
  applicationsDir,
  paths,
}) {
  const verified = await readLease(slot.slotId, paths, homeDir);
  const lease = verified.lease;
  if (expectedSessionId && expectedSessionId !== lease.ownerSessionId) {
    throw new DevSessionError("Beta recovery owner Session does not match", 5, {
      code: "beta_pool_lease_manifest_mismatch",
      slotId: slot.slotId,
      expectedOwnerSessionId: expectedSessionId,
      actualOwnerSessionId: lease.ownerSessionId,
    });
  }
  const runLocked = async () => {
    let current = (
      await inspectBetaPool({ homeDir, applicationsDir })
    ).slots.find((entry) => entry.slotId === slot.slotId);
    const base = createBetaPoolRecoveryReceipt({
      trigger,
      initiatingSessionId,
      slotId: slot.slotId,
      ownerSessionId: lease.ownerSessionId,
      leaseNonce: lease.leaseNonce,
      previousManifestState: current.manifest.state,
      previousDerivedState: current.derivedState,
      checks: current.recovery.checks,
    });
    const allowed =
      current.recovery.eligible &&
      (strategy === "capacity_pressure" || current.recovery.mode === "hygiene");
    if (!allowed) {
      return await persistNonMutatingReceipt(
        {
          ...base,
          completedAt: new Date().toISOString(),
          result: "preserved",
          blockedBy: current.recovery.blockedBy,
          code: current.recovery.code,
          expected: current.recovery.expected,
          actual: current.recovery.actual,
          suggestedAction: current.recovery.suggestedAction,
        },
        homeDir,
      );
    }
    if (
      strategy === "capacity_pressure" &&
      current.derivedState === "partial"
    ) {
      await sleep(secondCheckDelayMs);
      current = (
        await inspectBetaPool({ homeDir, applicationsDir })
      ).slots.find((entry) => entry.slotId === slot.slotId);
      if (current.derivedState !== "partial" || !current.recovery.eligible) {
        return await persistNonMutatingReceipt(
          {
            ...base,
            completedAt: new Date().toISOString(),
            result: "preserved",
            checks: current.recovery.checks,
            blockedBy: ["runtime-recovered-during-second-check"],
          },
          homeDir,
        );
      }
    }
    const manifest = await readOwnerManifest(lease);
    const stoppedServices = manifest
      ? await stopRecordedDedicatedServices(manifest, lease, homeDir)
      : [];
    return (
      await finalizeBetaSlotRelease({
        lease,
        manifest,
        receipt: { ...base, stoppedServices },
        homeDir,
        applicationsDir,
        claimAlreadyHeld: true,
      })
    ).receipt;
  };

  const manifest = await readOwnerManifest(lease);
  if (!manifest) {
    return await runLocked();
  }
  const lockEnv = ownerSessionLockEnv(lease);
  if (!lockEnv) {
    return await persistNonMutatingReceipt(
      {
        ...createBetaPoolRecoveryReceipt({
          trigger,
          initiatingSessionId,
          slotId: slot.slotId,
          ownerSessionId: lease.ownerSessionId,
          leaseNonce: lease.leaseNonce,
          previousManifestState: manifest.state,
          previousDerivedState: slot.derivedState,
        }),
        completedAt: new Date().toISOString(),
        result: "blocked",
        blockedBy: ["owner-session-lock-unresolvable"],
      },
      homeDir,
    );
  }
  try {
    return await withSessionLock(lease.ownerSessionId, runLocked, lockEnv);
  } catch (error) {
    if (
      error instanceof DevSessionError &&
      /session is busy/.test(error.message)
    ) {
      return await persistNonMutatingReceipt(
        {
          ...createBetaPoolRecoveryReceipt({
            trigger,
            initiatingSessionId,
            slotId: slot.slotId,
            ownerSessionId: lease.ownerSessionId,
            leaseNonce: lease.leaseNonce,
            previousManifestState: manifest.state,
            previousDerivedState: slot.derivedState,
          }),
          completedAt: new Date().toISOString(),
          result: "preserved",
          blockedBy: ["owner-session-busy"],
        },
        homeDir,
      );
    }
    throw error;
  }
}

export async function recoverBetaPoolSlot({
  slotId,
  sessionId = null,
  trigger = "explicit_recover",
  initiatingSessionId = null,
  strategy = "capacity_pressure",
  secondCheckDelayMs = 5_000,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
} = {}) {
  await assertBetaPoolStorageReadyForExistingLease({ homeDir });
  assertBetaSlotId(slotId);
  const paths = resolveBetaPoolPaths(homeDir);
  const claim = await acquireBetaSlotRecoveryClaim(slotId, paths);
  if (!claim) {
    return {
      ...createBetaPoolRecoveryReceipt({
        trigger,
        initiatingSessionId,
        slotId,
      }),
      completedAt: new Date().toISOString(),
      result: "preserved",
      blockedBy: ["recovery-claim-busy"],
    };
  }
  try {
    const slot = (
      await inspectBetaPool({ homeDir, applicationsDir })
    ).slots.find((entry) => entry.slotId === slotId);
    if (slot.derivedState === "idle") {
      return createBetaPoolRecoveryReceipt({
        trigger,
        initiatingSessionId,
        slotId,
        result: "preserved",
        completedAt: new Date().toISOString(),
        blockedBy: ["slot-already-idle"],
      });
    }
    if (slot.lease.state === "corrupt") {
      if (sessionId) {
        throw new DevSessionError(
          "--session is not allowed when a corrupt lease has no readable owner",
          2,
        );
      }
      return await quarantineCorruptLease({
        slot,
        trigger,
        initiatingSessionId,
        homeDir,
        applicationsDir,
        paths,
      });
    }
    if (slot.lease.state !== "valid") {
      throw new DevSessionError("Beta slot lease is not recoverable", 5, {
        slotId,
      });
    }
    if (trigger === "explicit_recover" && !sessionId) {
      throw new DevSessionError(
        "--session is required for a valid Beta slot lease",
        2,
      );
    }
    return await recoverValidLease({
      slot,
      trigger,
      initiatingSessionId,
      expectedSessionId: sessionId,
      strategy,
      secondCheckDelayMs,
      homeDir,
      applicationsDir,
      paths,
    });
  } finally {
    await releaseBetaSlotRecoveryClaim(claim, paths);
  }
}
