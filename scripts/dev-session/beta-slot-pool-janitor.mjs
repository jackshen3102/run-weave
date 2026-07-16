import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveBetaUpdateTargets } from "../runweave-update-core.mjs";
import {
  inspectProcessReferences,
  inspectRecordedProcessState,
} from "../runweave-beta-state.mjs";
import { DevSessionError } from "./contracts.mjs";
import { processIdentityMatches } from "./service-runtime.mjs";
import { stopOwnedProcess } from "./shared-services.mjs";
import {
  BETA_SLOT_IDS,
  acquireBetaSlotRecoveryClaim,
  assertBetaSlotLease,
  atomicWriteJson,
  inspectSlot,
  isPidLive,
  readRegularJson,
  releaseBetaSlotLease,
  releaseBetaSlotRecoveryClaim,
  resolveBetaPoolPaths,
} from "./beta-slot-pool-core.mjs";
import {
  applyBetaSlotRetention,
  recordBetaSlotRelease,
  resetBetaSlotMutableState,
} from "./beta-slot-pool-storage.mjs";

const execFileAsync = promisify(execFile);

async function readLeaseManifest(lease) {
  try {
    const handle = await fs.open(
      lease.ownerManifestPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return null;
      }
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function recordedSlotProcessesAreAbsent(slotId, homeDir) {
  const targets = resolveBetaUpdateTargets(homeDir, slotId);
  const [desktop, backend, appServer, references] = await Promise.all([
    inspectRecordedProcessState(
      path.join(targets.userData, "beta-desktop-status.json"),
      ["app", "pid"],
    ),
    inspectRecordedProcessState(
      path.join(targets.userData, "browser-profile", "backend.lock.json"),
      ["pid"],
    ),
    inspectRecordedProcessState(
      path.join(targets.appServerHome, "app-server.lock.json"),
      ["pid"],
    ),
    inspectProcessReferences([
      targets.appPath,
      targets.instanceRoot,
      targets.userData,
      targets.appServerHome,
    ]),
  ]);
  const evidence = [desktop, backend, appServer, references];
  return evidence.every((entry) => entry.trusted && !entry.active);
}

async function stopRecordedDedicatedServices(manifest, lease) {
  const dedicatedServices = [
    manifest.services?.electron,
    manifest.services?.backend,
    manifest.services?.appServer,
  ].filter((service) => service?.ownership === "dedicated");
  for (const service of dedicatedServices) {
    if (
      isPidLive(service.process?.pid) &&
      !processIdentityMatches(service.process)
    ) {
      throw new DevSessionError(
        "Beta janitor found a reused or identity-drifted PID",
        5,
        { slotId: lease.slotId, pid: service.process.pid },
      );
    }
  }
  const sourceRoot = manifest.source?.root;
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    throw new DevSessionError(
      "Beta janitor manifest source root is invalid",
      5,
      {
        slotId: lease.slotId,
      },
    );
  }
  const controlScript = path.join(sourceRoot, "scripts", "runweave-beta.mjs");
  if (await fs.lstat(controlScript).catch(() => null)) {
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
  }
  for (const service of dedicatedServices) {
    if (isPidLive(service.process?.pid)) {
      await stopOwnedProcess(service.process);
    }
  }
}

export async function runBetaPoolJanitor({
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
} = {}) {
  const paths = resolveBetaPoolPaths(homeDir);
  const summary = {
    scannedAt: new Date().toISOString(),
    recovered: [],
    active: [],
    broken: [],
  };
  for (const slotId of BETA_SLOT_IDS) {
    const recoveryClaim = await acquireBetaSlotRecoveryClaim(slotId, paths);
    if (!recoveryClaim) {
      summary.active.push({
        slotId,
        ownerSessionId: null,
        state: "recovering",
      });
      continue;
    }
    try {
      const inspected = await inspectSlot(slotId, paths);
      if (inspected.state === "idle") {
        continue;
      }
      if (inspected.state === "broken") {
        summary.broken.push({ slotId, reason: inspected.reason });
        continue;
      }
      const verified = await assertBetaSlotLease({
        slotId,
        ownerSessionId: inspected.ownerSessionId,
        leaseNonce: (
          await readRegularJson(
            path.join(paths.leasesDir, `${slotId}.lock`),
            paths.poolRoot,
          )
        ).value.leaseNonce,
        homeDir,
      });
      const lease = verified.lease;
      const manifest = await readLeaseManifest(lease);
      if (!manifest) {
        const orphanAgeMs = Date.now() - Date.parse(lease.acquiredAt);
        if (
          isPidLive(lease.allocatorPid) ||
          orphanAgeMs <= 10 * 60_000 ||
          !(await recordedSlotProcessesAreAbsent(slotId, homeDir))
        ) {
          summary.broken.push({
            slotId,
            reason: "lease manifest is missing and orphan identity is not safe",
          });
          continue;
        }
      } else {
        const betaSlot = manifest.targetEnvironment?.betaSlot;
        if (
          manifest.devSessionId !== lease.ownerSessionId ||
          betaSlot?.assignedSlotId !== slotId ||
          betaSlot?.leaseNonce !== lease.leaseNonce
        ) {
          summary.broken.push({
            slotId,
            reason: "lease and manifest owner identity do not match",
          });
          continue;
        }
        if (
          ["ready", "stopping"].includes(manifest.state) ||
          isPidLive(lease.allocatorPid)
        ) {
          summary.active.push({
            slotId,
            ownerSessionId: lease.ownerSessionId,
            state: manifest.state,
          });
          continue;
        }
        if (
          !["planned", "starting", "failed", "stale"].includes(manifest.state)
        ) {
          summary.broken.push({
            slotId,
            reason: `manifest state is not recoverable: ${String(manifest.state)}`,
          });
          continue;
        }
        try {
          await stopRecordedDedicatedServices(manifest, lease);
        } catch (error) {
          summary.broken.push({
            slotId,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
      try {
        const reset = await resetBetaSlotMutableState({ slotId, homeDir });
        const retention = await applyBetaSlotRetention({
          slotId,
          homeDir,
          applicationsDir,
        });
        await recordBetaSlotRelease({
          slotId,
          revision: lease.ownerRevision,
          cleanupSummary: { ...reset, retention, recoveredByJanitor: true },
          homeDir,
        });
        if (manifest) {
          await atomicWriteJson(
            lease.ownerManifestPath,
            {
              ...manifest,
              state: "stopped",
              updatedAt: new Date().toISOString(),
              failure: null,
            },
            path.dirname(lease.ownerManifestPath),
          );
        }
        await releaseBetaSlotLease({
          slotId,
          ownerSessionId: lease.ownerSessionId,
          leaseNonce: lease.leaseNonce,
          homeDir,
        });
        summary.recovered.push({
          slotId,
          ownerSessionId: lease.ownerSessionId,
        });
      } catch (error) {
        summary.broken.push({
          slotId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      await releaseBetaSlotRecoveryClaim(recoveryClaim, paths);
    }
  }
  return summary;
}
