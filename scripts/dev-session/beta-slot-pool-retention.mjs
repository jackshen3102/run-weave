import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveBetaAppBackupPrefix,
  resolveBetaUpdateTargets,
} from "../runweave-update-core.mjs";
import { DevSessionError, assertPathInside } from "./contracts.mjs";
import { assertBetaSlotId } from "./beta-slot-pool-core.mjs";

async function lstatOptional(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function retentionStateError(message, details) {
  return new DevSessionError(message, 5, {
    code: "beta_slot_retention_state_broken",
    ...details,
  });
}

export async function validateBetaRuntimeReleaseAllowlist(
  runtimeHome,
  previousReleaseId,
) {
  const pointerPath = path.join(runtimeHome, "current.json");
  const releasesDir = path.join(runtimeHome, "releases");
  const pointerExists = await lstatOptional(pointerPath);
  const releasesExist = await lstatOptional(releasesDir);
  if (!pointerExists && !releasesExist) {
    return new Set();
  }
  if (
    !pointerExists ||
    pointerExists.isSymbolicLink() ||
    !pointerExists.isFile()
  ) {
    throw retentionStateError("runtime current pointer is missing or unsafe", {
      runtimeHome,
    });
  }
  let pointer;
  try {
    pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw retentionStateError("runtime current pointer is corrupt", {
      runtimeHome,
    });
  }
  const isSafeReleaseId = (value) =>
    typeof value === "string" &&
    Boolean(value) &&
    !value.includes("/") &&
    !value.includes("..");
  if (!isSafeReleaseId(pointer.releaseId)) {
    throw retentionStateError("runtime current pointer is corrupt", {
      runtimeHome,
    });
  }
  if (
    previousReleaseId !== null &&
    previousReleaseId !== undefined &&
    !isSafeReleaseId(previousReleaseId)
  ) {
    throw retentionStateError("runtime previous pointer is corrupt", {
      runtimeHome,
      releaseId: previousReleaseId,
    });
  }
  const allowlist = new Set([pointer.releaseId]);
  if (previousReleaseId) {
    allowlist.add(previousReleaseId);
  }
  for (const releaseId of allowlist) {
    const releasePath = path.join(releasesDir, releaseId);
    const stats = await lstatOptional(releasePath);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw retentionStateError(
        "runtime pointer references a missing release",
        {
          runtimeHome,
          releaseId,
        },
      );
    }
  }
  return allowlist;
}

export async function readBetaSlotWarmState(targets, slotId) {
  const stateStats = await lstatOptional(targets.statePath);
  if (!stateStats) {
    return null;
  }
  if (!stateStats.isFile() || stateStats.isSymbolicLink()) {
    throw retentionStateError("Beta warm-state pointer is unsafe", {
      slotId,
      statePath: targets.statePath,
    });
  }
  try {
    return JSON.parse(await fs.readFile(targets.statePath, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw retentionStateError("Beta warm-state pointer is corrupt", {
      slotId,
      statePath: targets.statePath,
    });
  }
}

async function readEffectiveWarmState(targets, slotId) {
  const pendingPath = path.join(
    targets.instanceRoot,
    "diagnostics",
    "pending.json",
  );
  let pending = null;
  try {
    pending = JSON.parse(await fs.readFile(pendingPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  if (!pending?.baseline?.app?.backupPath) {
    return {
      state: await readBetaSlotWarmState(targets, slotId),
      pending: false,
    };
  }
  const rollbackStats = await lstatOptional(pending.baseline.app.backupPath);
  if (!rollbackStats?.isDirectory() || rollbackStats.isSymbolicLink()) {
    return {
      state: await readBetaSlotWarmState(targets, slotId),
      pending: false,
    };
  }
  const existingState = await fs
    .readFile(targets.statePath, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  const baseline = structuredClone(pending.baseline);
  if ((existingState?.mode ?? "app") !== "app") {
    baseline.app.backupPath = baseline.priorAppBackupPath ?? null;
  }
  return {
    state: {
      ...existingState,
      channel: "beta",
      previous: baseline,
      logPath: pending.logPath ?? null,
      lastFailure: null,
    },
    pending: true,
  };
}

async function validateAppBackupReferences({
  slotId,
  targets,
  state,
  applicationsDir,
}) {
  const referencedBackup = state?.previous?.app?.backupPath ?? null;
  const backupPrefix = path.basename(
    resolveBetaAppBackupPrefix(slotId, applicationsDir),
  );
  const isRollbackEntry = (entry) =>
    entry === backupPrefix ||
    (entry.startsWith(`${backupPrefix}-`) &&
      /^\d+$/.test(entry.slice(backupPrefix.length + 1)));
  const legacyBackupPrefix = `.${targets.appName}.app.previous`;
  let applicationEntries;
  try {
    applicationEntries = await fs.readdir(applicationsDir);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    applicationEntries = [];
  }
  const backupPaths = applicationEntries
    .filter(isRollbackEntry)
    .map((entry) => path.join(applicationsDir, entry));
  const legacyBackupPaths = applicationEntries
    .filter((entry) => entry.startsWith(legacyBackupPrefix))
    .map((entry) => path.join(applicationsDir, entry));
  const allBackupPaths = [...backupPaths, ...legacyBackupPaths];
  if (allBackupPaths.length > 0 && !referencedBackup) {
    throw retentionStateError("Beta app previous pointer is missing", {
      slotId,
      backups: allBackupPaths,
    });
  }
  let referenceKind = null;
  if (referencedBackup && state?.previous?.app?.exists === true) {
    const resolvedBackup = path.resolve(referencedBackup);
    if (path.basename(referencedBackup).startsWith(legacyBackupPrefix)) {
      if (!legacyBackupPaths.includes(resolvedBackup)) {
        throw retentionStateError(
          "Beta legacy app previous pointer is invalid",
          {
            slotId,
            referencedBackup,
          },
        );
      }
      const suffix = path
        .basename(resolvedBackup)
        .slice(legacyBackupPrefix.length);
      const migratedBackup = path.join(
        applicationsDir,
        `${backupPrefix}${suffix}`,
      );
      if (backupPaths.includes(migratedBackup)) {
        throw retentionStateError("Beta app rollback target already exists", {
          slotId,
          migratedBackup,
        });
      }
      referenceKind = "legacy";
    } else if (
      !backupPaths.includes(resolvedBackup) ||
      !path.basename(referencedBackup).startsWith(backupPrefix)
    ) {
      throw retentionStateError("Beta app previous pointer is invalid", {
        slotId,
        referencedBackup,
      });
    } else {
      referenceKind = "rollback";
    }
  }
  return {
    referencedBackup,
    referenceKind,
    backupPrefix,
    legacyBackupPrefix,
    backupPaths,
    legacyBackupPaths,
  };
}

export async function validateBetaSlotRetentionState({
  slotId,
  targets,
  state,
  applicationsDir,
}) {
  const desktopPrevious = state?.previous?.runtimeReleaseId ?? null;
  const appServerPrevious = state?.previous?.appServerReleaseId ?? null;
  const [desktopAllowlist, appServerAllowlist] = await Promise.all([
    validateBetaRuntimeReleaseAllowlist(targets.runtimeHome, desktopPrevious),
    validateBetaRuntimeReleaseAllowlist(
      path.join(targets.appServerHome, "runtime"),
      appServerPrevious,
    ),
  ]);
  const appBackups = await validateAppBackupReferences({
    slotId,
    targets,
    state,
    applicationsDir,
  });
  return {
    desktopPrevious,
    appServerPrevious,
    desktopAllowlist,
    appServerAllowlist,
    appBackups,
  };
}

export async function assertNoBetaSlotSymlinkComponents(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = assertPathInside(root, targetPath, "Beta controlled path");
  const rootStats = await fs.lstat(root).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (rootStats?.isSymbolicLink()) {
    throw new DevSessionError("Beta controlled root is a symlink", 5, {
      path: root,
    });
  }
  let current = root;
  for (const component of path.relative(root, target).split(path.sep)) {
    if (!component) {
      continue;
    }
    current = path.join(current, component);
    const stats = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!stats) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new DevSessionError("Beta controlled path contains a symlink", 5, {
        path: current,
      });
    }
  }
}

export async function inspectBetaSlotRetentionSafety({
  slotId,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
}) {
  const targets = resolveBetaUpdateTargets(homeDir, assertBetaSlotId(slotId));
  try {
    await assertNoBetaSlotSymlinkComponents(homeDir, targets.runtimeHome);
    await assertNoBetaSlotSymlinkComponents(
      path.join(homeDir, ".runweave"),
      path.join(targets.appServerHome, "runtime"),
    );
    const effective = await readEffectiveWarmState(targets, slotId);
    await validateBetaSlotRetentionState({
      slotId,
      targets,
      state: effective.state,
      applicationsDir,
    });
    return {
      healthy: true,
      pendingReconciliation: effective.pending,
      reason: null,
      details: null,
    };
  } catch (error) {
    if (!(error instanceof DevSessionError)) {
      throw error;
    }
    return {
      healthy: false,
      pendingReconciliation: false,
      reason: error.message,
      details: error.details ?? null,
    };
  }
}
