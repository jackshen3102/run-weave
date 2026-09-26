import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DevSessionError, assertDevSessionId } from "../../contracts.mjs";
import { readManifest, withSessionLock } from "../../registry.mjs";
import { withBetaLock } from "../../../beta/operations.mjs";
import { readReleaseId, resolveBetaPaths } from "../../../beta/state.mjs";
import {
  acquireBetaSlotRecoveryClaim,
  assertBetaSlotId,
  atomicWriteJson,
  readRegularJson,
  releaseBetaSlotRecoveryClaim,
  resolveBetaPoolPaths,
} from "../core.mjs";
import { betaSlotProcessesAreAbsent } from "../process-inspection.mjs";
import {
  assertNoBetaSlotSymlinkComponents,
  inspectBetaSlotRetentionSafety,
  resolveBetaSlotRetentionTargets,
} from "../retention.mjs";

function refuse(reason) {
  throw new DevSessionError(`runtime reference repair refused: ${reason}`, 5);
}

async function restoreOriginalBytes(statePath, original) {
  const temporaryPath = path.join(
    path.dirname(statePath),
    `.state.restore-${randomUUID()}.tmp`,
  );
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(original);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, statePath);
}

async function inspect({
  slotId,
  sessionId,
  expectedDigest,
  homeDir,
  applicationsDir,
}) {
  const manifest = await readManifest(sessionId, {
    ...process.env,
    RUNWEAVE_DEV_SESSION_HOME: path.join(homeDir, ".runweave", "dev-sessions"),
  });
  if (
    manifest.devSessionId !== sessionId ||
    !["stopped", "failed"].includes(manifest.state)
  ) {
    refuse("owning Session is not stopped");
  }
  const pool = resolveBetaPoolPaths(homeDir);
  const lease = await fs
    .lstat(path.join(pool.leasesDir, `${slotId}.lock`))
    .catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
  if (lease || !(await betaSlotProcessesAreAbsent(slotId, homeDir))) {
    refuse("slot still has a lease or process");
  }
  const targets = await resolveBetaSlotRetentionTargets(homeDir, slotId);
  const { value: state } = await readRegularJson(
    targets.statePath,
    targets.instanceRoot,
  );
  if (
    state?.devSessionId !== sessionId ||
    state?.sourceRoot !== manifest.source.root
  ) {
    refuse("warm-state ownership differs from the stopped Session");
  }
  const handle = await fs.open(
    targets.statePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let original;
  try {
    original = await handle.readFile();
  } finally {
    await handle.close();
  }
  const digest = createHash("sha256").update(original).digest("hex");
  if (digest !== expectedDigest) refuse("warm-state digest changed");
  const changes = [];
  const repaired = structuredClone(state);
  for (const field of ["runtimeReleaseId", "appServerReleaseId"]) {
    const runtimeHome =
      field === "runtimeReleaseId"
        ? targets.runtimeHome
        : path.join(targets.appServerHome, "runtime");
    const currentPath = path.join(runtimeHome, "current.json");
    await assertNoBetaSlotSymlinkComponents(homeDir, currentPath);
    const current = await readReleaseId(currentPath);
    if (current) {
      const currentRelease = path.join(runtimeHome, "releases", current);
      await assertNoBetaSlotSymlinkComponents(homeDir, currentRelease);
      if (!(await fs.lstat(currentRelease).catch(() => null))?.isDirectory()) {
        refuse(`${field} current pointer is unusable`);
      }
    }
    for (const [owner, object] of [
      ["current", repaired],
      ["previous", repaired.previous],
    ]) {
      if (owner === "previous" && repaired.previous?.devSessionId !== sessionId)
        continue;
      if (!object?.[field]) continue;
      const release = path.join(runtimeHome, "releases", object[field]);
      await assertNoBetaSlotSymlinkComponents(homeDir, release);
      if ((await fs.lstat(release).catch(() => null))?.isDirectory()) continue;
      if (owner === "current" && !current)
        refuse(`${field} has no usable replacement`);
      const replacement = owner === "current" ? current : null;
      changes.push({
        field: `${owner}.${field}`,
        missingReleaseId: object[field],
        replacement,
      });
      object[field] = replacement;
    }
  }
  if (changes.length === 0) refuse("no missing runtime reference was found");
  return {
    targets,
    state,
    repaired,
    original,
    digest,
    changes,
    applicationsDir,
  };
}

export async function repairBetaRuntimeReferences({
  slotId,
  sessionId,
  expectedDigest,
  dryRun = false,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
}) {
  assertBetaSlotId(slotId);
  assertDevSessionId(sessionId);
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest ?? "")) {
    throw new DevSessionError("repair requires --expected-digest SHA-256", 2);
  }
  if (dryRun) {
    const preview = await inspect({
      slotId,
      sessionId,
      expectedDigest,
      homeDir,
      applicationsDir,
    });
    return {
      dryRun: true,
      slotId,
      sessionId,
      expectedDigest,
      changes: preview.changes,
    };
  }
  const pool = resolveBetaPoolPaths(homeDir);
  const claim = await acquireBetaSlotRecoveryClaim(slotId, pool);
  if (!claim) refuse("recovery claim is busy");
  try {
    return await withSessionLock(
      sessionId,
      async () => {
        const preview = await inspect({
          slotId,
          sessionId,
          expectedDigest,
          homeDir,
          applicationsDir,
        });
        const paths = resolveBetaPaths(
          preview.state.sourceRoot,
          homeDir,
          slotId,
          sessionId,
        );
        paths.appPath = path.join(
          applicationsDir,
          path.basename(paths.appPath),
        );
        return await withBetaLock(paths, async () => {
          const checked = await inspect({
            slotId,
            sessionId,
            expectedDigest,
            homeDir,
            applicationsDir,
          });
          const id = randomUUID();
          const backupPath = path.join(
            checked.targets.warmStateRoot,
            `state.repair-${id}.json`,
          );
          await fs.writeFile(backupPath, checked.original, {
            flag: "wx",
            mode: 0o600,
          });
          const receipt = {
            schemaVersion: 1,
            slotId,
            sessionId,
            originalDigest: checked.digest,
            backupPath,
            changes: checked.changes,
            repairedAt: new Date().toISOString(),
          };
          await atomicWriteJson(
            checked.targets.statePath,
            {
              ...checked.repaired,
              runtimeReferenceRepair: receipt,
            },
            checked.targets.instanceRoot,
          );
          const safety = await inspectBetaSlotRetentionSafety({
            slotId,
            homeDir,
            applicationsDir,
          });
          if (!safety.healthy) {
            await restoreOriginalBytes(
              checked.targets.statePath,
              checked.original,
            );
            refuse(`repaired slot remains unsafe: ${safety.reason}`);
          }
          return { dryRun: false, ...receipt };
        });
      },
      {
        ...process.env,
        RUNWEAVE_DEV_SESSION_HOME: path.join(
          homeDir,
          ".runweave",
          "dev-sessions",
        ),
      },
    );
  } finally {
    await releaseBetaSlotRecoveryClaim(claim, pool);
  }
}
