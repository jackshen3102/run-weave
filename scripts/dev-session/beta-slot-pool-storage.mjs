import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  resolveBetaAppBackupPrefix,
  resolveBetaUpdateTargets,
} from "../runweave-update-core.mjs";
import { DevSessionError, assertPathInside } from "./contracts.mjs";
import {
  DEFAULT_BETA_POOL_MIN_FREE_BYTES,
  assertBetaSlotId,
  atomicWriteJson,
} from "./beta-slot-pool-core.mjs";

const execFileAsync = promisify(execFile);
const MAX_UPDATE_LOGS = 5;
const MAX_UPDATE_LOG_BYTES = 64 * 1024 * 1024;
const MIN_PLANNED_WRITE_BYTES = 512 * 1024 * 1024;
const LAUNCH_SERVICES_REGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

async function unregisterApplicationPath(appPath, applicationsDir) {
  if (
    process.platform !== "darwin" ||
    path.resolve(applicationsDir) !== "/Applications"
  ) {
    return false;
  }
  return await execFileAsync(LAUNCH_SERVICES_REGISTER, ["-u", appPath])
    .then(() => true)
    .catch(() => false);
}

async function calculatePathBytes(targetPath, rejectSymlink = true) {
  const stats = await fs.lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stats) {
    return 0;
  }
  if (stats.isSymbolicLink()) {
    if (rejectSymlink) {
      throw new DevSessionError("refusing to size a symlinked Beta path", 4, {
        path: targetPath,
      });
    }
    return stats.size;
  }
  if (!stats.isDirectory()) {
    return stats.size;
  }
  let bytes = 0;
  for (const entry of await fs.readdir(targetPath)) {
    bytes += await calculatePathBytes(path.join(targetPath, entry), false);
  }
  return bytes;
}

async function nearestExistingPath(targetPath) {
  let candidate = path.resolve(targetPath);
  while (!(await fs.lstat(candidate).catch(() => null))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new DevSessionError(
        "cannot resolve filesystem for Beta target",
        4,
        {
          path: targetPath,
        },
      );
    }
    candidate = parent;
  }
  return candidate;
}

async function calculateTrackedSourceBytes(sourceRoot) {
  const { stdout } = await execFileAsync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "electron",
      "app-server",
      "frontend",
      "backend",
      "packages/common",
      "packages/shared",
      "packages/terminal-renderer",
      "packages/runweave-cli",
      "scripts",
    ],
    { cwd: sourceRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  let bytes = 0;
  for (const relativePath of stdout.split("\0").filter(Boolean)) {
    const filePath = assertPathInside(
      sourceRoot,
      path.join(sourceRoot, relativePath),
    );
    const stats = await fs.lstat(filePath);
    bytes += stats.size;
  }
  return bytes;
}

export async function assertBetaPoolDiskBudget({
  sourceRoot,
  slotId,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
  env = process.env,
  cleanedBytes = 0,
}) {
  const targets = resolveBetaUpdateTargets(homeDir, assertBetaSlotId(slotId));
  const appPath = path.join(applicationsDir, path.basename(targets.appPath));
  const configured = env.RUNWEAVE_BETA_POOL_MIN_FREE_BYTES?.trim();
  const configuredFloor = configured
    ? Number(configured)
    : DEFAULT_BETA_POOL_MIN_FREE_BYTES;
  if (!Number.isSafeInteger(configuredFloor) || configuredFloor < 0) {
    throw new DevSessionError(
      "RUNWEAVE_BETA_POOL_MIN_FREE_BYTES must be a non-negative integer",
      2,
      { value: configured ?? null },
    );
  }
  const estimates = await Promise.all([
    calculatePathBytes(appPath),
    calculatePathBytes(targets.runtimeHome),
    calculatePathBytes(path.join(targets.appServerHome, "runtime")),
    calculateTrackedSourceBytes(sourceRoot),
  ]);
  const existingBytes = estimates[0] + estimates[1] + estimates[2];
  const plannedWriteBytes = Math.max(
    estimates.reduce((total, estimate) => total + estimate, 0),
    MIN_PLANNED_WRITE_BYTES,
  );
  if (!Number.isSafeInteger(plannedWriteBytes) || plannedWriteBytes <= 0) {
    throw new DevSessionError(
      "unable to estimate Beta pool planned writes",
      5,
      {
        slotId,
        estimates,
      },
    );
  }
  const requiredFreeBytes = Math.max(configuredFloor, plannedWriteBytes * 3);
  const filesystemPaths = await Promise.all([
    nearestExistingPath(appPath),
    nearestExistingPath(targets.instanceRoot),
    nearestExistingPath(targets.appServerHome),
  ]);
  const freeBytesByPath = await Promise.all(
    filesystemPaths.map(async (filesystemPath) => {
      const stats = await fs.statfs(filesystemPath);
      return {
        path: filesystemPath,
        freeBytes: stats.bavail * stats.bsize,
      };
    }),
  );
  const freeBytes = Math.min(
    ...freeBytesByPath.map((entry) => entry.freeBytes),
  );
  const summary = {
    slotId,
    freeBytes,
    requiredFreeBytes,
    configuredFloor,
    plannedWriteBytes,
    cleanedBytes,
    retainedBytes: existingBytes,
    filesystems: freeBytesByPath,
  };
  if (freeBytes < requiredFreeBytes) {
    throw new DevSessionError(
      "insufficient disk space for Beta slot start",
      5,
      {
        diskSummary: summary,
      },
    );
  }
  return summary;
}

async function validateReleaseAllowlist(runtimeHome, previousReleaseId) {
  const pointerPath = path.join(runtimeHome, "current.json");
  const releasesDir = path.join(runtimeHome, "releases");
  const pointerExists = await fs.lstat(pointerPath).catch(() => null);
  const releasesExist = await fs.lstat(releasesDir).catch(() => null);
  if (!pointerExists && !releasesExist) {
    return new Set();
  }
  if (
    !pointerExists ||
    pointerExists.isSymbolicLink() ||
    !pointerExists.isFile()
  ) {
    throw new DevSessionError(
      "runtime current pointer is missing or unsafe",
      5,
      {
        runtimeHome,
      },
    );
  }
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  if (
    typeof pointer.releaseId !== "string" ||
    !pointer.releaseId ||
    pointer.releaseId.includes("/") ||
    pointer.releaseId.includes("..")
  ) {
    throw new DevSessionError("runtime current pointer is corrupt", 5, {
      runtimeHome,
    });
  }
  const allowlist = new Set([pointer.releaseId]);
  if (previousReleaseId) {
    allowlist.add(previousReleaseId);
  }
  for (const releaseId of allowlist) {
    const releasePath = path.join(releasesDir, releaseId);
    const stats = await fs.lstat(releasePath).catch(() => null);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new DevSessionError(
        "runtime pointer references a missing release",
        5,
        {
          runtimeHome,
          releaseId,
        },
      );
    }
  }
  return allowlist;
}

async function pruneRuntime(runtimeHome, previousReleaseId, validated = null) {
  const releasesDir = path.join(runtimeHome, "releases");
  const allowlist =
    validated ??
    (await validateReleaseAllowlist(runtimeHome, previousReleaseId));
  let cleanedBytes = 0;
  for (const entry of await fs.readdir(releasesDir).catch(() => [])) {
    if (allowlist.has(entry)) {
      continue;
    }
    const target = path.join(releasesDir, entry);
    cleanedBytes += await calculatePathBytes(target);
    await fs.rm(target, { recursive: true, force: true });
  }
  return { retainedReleaseIds: [...allowlist], cleanedBytes };
}

async function pruneLogs(logDir) {
  const entries = [];
  for (const entry of await fs.readdir(logDir).catch(() => [])) {
    const filePath = path.join(logDir, entry);
    const stats = await fs.lstat(filePath);
    if (stats.isFile() && !stats.isSymbolicLink()) {
      entries.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let cleanedBytes = 0;
  while (
    entries.length > MAX_UPDATE_LOGS ||
    totalBytes > MAX_UPDATE_LOG_BYTES
  ) {
    const removed = entries.shift();
    await fs.rm(removed.filePath);
    totalBytes -= removed.size;
    cleanedBytes += removed.size;
  }
  return { count: entries.length, bytes: totalBytes, cleanedBytes };
}

async function pruneArtifacts(artifactsRoot, allowlist) {
  let cleanedBytes = 0;
  for (const entry of await fs.readdir(artifactsRoot).catch(() => [])) {
    const artifactMatch = /^runweave-runtime-(.+?)(?:\.zip)?$/.exec(entry);
    const releaseId = artifactMatch?.[1] ?? entry;
    if (allowlist.has(releaseId)) continue;
    const target = path.join(artifactsRoot, entry);
    cleanedBytes += await calculatePathBytes(target);
    await fs.rm(target, { recursive: true, force: true });
  }
  return { cleanedBytes };
}

export async function applyBetaSlotRetention({
  slotId,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
}) {
  const targets = resolveBetaUpdateTargets(homeDir, assertBetaSlotId(slotId));
  await assertNoSymlinkComponents(homeDir, targets.runtimeHome);
  await assertNoSymlinkComponents(
    path.join(homeDir, ".runweave"),
    path.join(targets.appServerHome, "runtime"),
  );

  const pendingPath = path.join(
    targets.instanceRoot,
    "diagnostics",
    "pending.json",
  );
  let pending = null;
  try {
    const raw = await fs.readFile(pendingPath, "utf8");
    pending = JSON.parse(raw);
  } catch {
    // pending.json is absent or corrupt — nothing to consume
  }
  if (pending?.baseline?.app?.backupPath) {
    const rollbackStats = await fs
      .lstat(pending.baseline.app.backupPath)
      .catch(() => null);
    if (rollbackStats?.isDirectory()) {
      const existingState = await fs
        .readFile(targets.statePath, "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      const mode = existingState?.mode ?? "app";
      const baseline = { ...pending.baseline };
      if (mode !== "app") {
        baseline.app.backupPath = baseline.priorAppBackupPath ?? null;
      }
      await atomicWriteJson(
        targets.statePath,
        {
          ...existingState,
          channel: "beta",
          previous: baseline,
          logPath: pending.logPath ?? null,
          lastFailure: null,
        },
        targets.instanceRoot,
      );
    }
    await fs.rm(pendingPath, { force: true });
  }

  const stateStats = await fs.lstat(targets.statePath).catch(() => null);
  let state = null;
  if (stateStats) {
    if (!stateStats.isFile() || stateStats.isSymbolicLink()) {
      throw new DevSessionError("Beta warm-state pointer is unsafe", 5, {
        slotId,
        statePath: targets.statePath,
      });
    }
    try {
      state = JSON.parse(await fs.readFile(targets.statePath, "utf8"));
    } catch {
      throw new DevSessionError("Beta warm-state pointer is corrupt", 5, {
        slotId,
        statePath: targets.statePath,
      });
    }
  }
  const desktopPrevious = state?.previous?.runtimeReleaseId ?? null;
  const appServerPrevious = state?.previous?.appServerReleaseId ?? null;
  const [desktopAllowlist, appServerAllowlist] = await Promise.all([
    validateReleaseAllowlist(targets.runtimeHome, desktopPrevious),
    validateReleaseAllowlist(
      path.join(targets.appServerHome, "runtime"),
      appServerPrevious,
    ),
  ]);
  let referencedBackup = state?.previous?.app?.backupPath ?? null;
  const backupPrefix = path.basename(
    resolveBetaAppBackupPrefix(slotId, applicationsDir),
  );
  const isRollbackEntry = (entry) =>
    entry === backupPrefix ||
    (entry.startsWith(`${backupPrefix}-`) &&
      /^\d+$/.test(entry.slice(backupPrefix.length + 1)));
  const legacyBackupPrefix = `.${targets.appName}.app.previous`;
  const applicationEntries = await fs.readdir(applicationsDir).catch(() => []);
  const backupPaths = applicationEntries
    .filter(isRollbackEntry)
    .map((entry) => path.join(applicationsDir, entry));
  let legacyBackupPaths = applicationEntries
    .filter((entry) => entry.startsWith(legacyBackupPrefix))
    .map((entry) => path.join(applicationsDir, entry));
  let appBackupMigrated = false;
  let launchServicesUnregistered = 0;
  if (
    referencedBackup &&
    state?.previous?.app?.exists === true &&
    path.basename(referencedBackup).startsWith(legacyBackupPrefix)
  ) {
    const resolvedLegacyBackup = path.resolve(referencedBackup);
    if (!legacyBackupPaths.includes(resolvedLegacyBackup)) {
      throw new DevSessionError(
        "Beta legacy app previous pointer is invalid",
        5,
        {
          slotId,
          referencedBackup,
        },
      );
    }
    const suffix = path
      .basename(resolvedLegacyBackup)
      .slice(legacyBackupPrefix.length);
    const migratedBackup = path.join(
      applicationsDir,
      `${backupPrefix}${suffix}`,
    );
    if (await fs.lstat(migratedBackup).catch(() => null)) {
      throw new DevSessionError("Beta app rollback target already exists", 5, {
        slotId,
        migratedBackup,
      });
    }
    if (
      await unregisterApplicationPath(resolvedLegacyBackup, applicationsDir)
    ) {
      launchServicesUnregistered += 1;
    }
    await fs.rename(resolvedLegacyBackup, migratedBackup);
    try {
      state.previous.app.backupPath = migratedBackup;
      await atomicWriteJson(targets.statePath, state, targets.instanceRoot);
    } catch (error) {
      await fs
        .rename(migratedBackup, resolvedLegacyBackup)
        .catch(() => undefined);
      throw error;
    }
    referencedBackup = migratedBackup;
    backupPaths.push(migratedBackup);
    legacyBackupPaths = legacyBackupPaths.filter(
      (entry) => path.resolve(entry) !== resolvedLegacyBackup,
    );
    appBackupMigrated = true;
  }
  const allBackupPaths = [...backupPaths, ...legacyBackupPaths];
  if (allBackupPaths.length > 0 && !referencedBackup) {
    throw new DevSessionError("Beta app previous pointer is missing", 5, {
      slotId,
      backups: allBackupPaths,
    });
  }
  if (
    referencedBackup &&
    state?.previous?.app?.exists === true &&
    (!allBackupPaths.includes(path.resolve(referencedBackup)) ||
      !path.basename(referencedBackup).startsWith(backupPrefix))
  ) {
    throw new DevSessionError("Beta app previous pointer is invalid", 5, {
      slotId,
      referencedBackup,
    });
  }
  const [desktopRuntime, appServerRuntime, logs] = await Promise.all([
    pruneRuntime(targets.runtimeHome, desktopPrevious, desktopAllowlist),
    pruneRuntime(
      path.join(targets.appServerHome, "runtime"),
      appServerPrevious,
      appServerAllowlist,
    ),
    pruneLogs(path.join(targets.instanceRoot, "diagnostics", "logs")),
  ]);
  const artifactsRoot = path.join(targets.instanceRoot, "runtime-artifacts");
  const artifacts = await pruneArtifacts(artifactsRoot, desktopAllowlist);
  let appBackupCleanedBytes = 0;
  for (const backupPath of allBackupPaths) {
    if (
      referencedBackup &&
      path.resolve(backupPath) === path.resolve(referencedBackup)
    ) {
      continue;
    }
    if (
      path.basename(backupPath).startsWith(legacyBackupPrefix) &&
      (await unregisterApplicationPath(backupPath, applicationsDir))
    ) {
      launchServicesUnregistered += 1;
    }
    appBackupCleanedBytes += await calculatePathBytes(backupPath);
    await fs.rm(backupPath, { recursive: true, force: true });
  }
  return {
    desktopRuntime,
    appServerRuntime,
    logs,
    artifacts,
    appBackupMigrated,
    launchServicesUnregistered,
    appBackupCleanedBytes,
    cleanedBytes:
      desktopRuntime.cleanedBytes +
      appServerRuntime.cleanedBytes +
      logs.cleanedBytes +
      artifacts.cleanedBytes +
      appBackupCleanedBytes,
  };
}

async function assertSafeMutableRoot(targetPath, allowedRoot) {
  const resolved = assertPathInside(
    allowedRoot,
    targetPath,
    "Beta mutable path",
  );
  const stats = await fs.lstat(resolved).catch(() => null);
  if (stats?.isSymbolicLink()) {
    throw new DevSessionError("Beta mutable path must not be a symlink", 5, {
      path: resolved,
    });
  }
  return resolved;
}

async function assertNoSymlinkComponents(rootPath, targetPath) {
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

export async function resetBetaSlotMutableState({
  slotId,
  homeDir = os.homedir(),
  afterUserDataSwap = null,
}) {
  const targets = resolveBetaUpdateTargets(homeDir, assertBetaSlotId(slotId));
  await assertNoSymlinkComponents(homeDir, targets.instanceRoot);
  await assertNoSymlinkComponents(
    path.join(homeDir, ".runweave"),
    targets.appServerHome,
  );
  const userData = await assertSafeMutableRoot(
    targets.userData,
    targets.instanceRoot,
  );
  await fs.mkdir(targets.instanceRoot, { recursive: true, mode: 0o700 });
  const resetPath = path.join(
    targets.instanceRoot,
    `.user-data.reset-${randomUUID()}`,
  );
  if (await fs.lstat(userData).catch(() => null)) {
    await fs.rename(userData, resetPath);
  }
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  await afterUserDataSwap?.();
  await fs.rm(resetPath, { recursive: true, force: true });
  for (const entry of await fs.readdir(targets.instanceRoot)) {
    if (entry.startsWith(".user-data.reset-")) {
      await fs.rm(path.join(targets.instanceRoot, entry), {
        recursive: true,
        force: true,
      });
    }
  }

  const appServerHome = await assertSafeMutableRoot(
    targets.appServerHome,
    path.join(homeDir, ".runweave", "app-server-beta"),
  );
  await fs.mkdir(appServerHome, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(appServerHome)) {
    if (entry === "runtime") {
      const runtimeStats = await fs.lstat(path.join(appServerHome, entry));
      if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink()) {
        throw new DevSessionError(
          "Beta App Server runtime must be a regular directory",
          5,
          { path: path.join(appServerHome, entry) },
        );
      }
      continue;
    }
    await fs.rm(path.join(appServerHome, entry), {
      recursive: true,
      force: true,
    });
  }
  for (const temporaryPath of [
    path.join(targets.instanceRoot, "build"),
    path.join(targets.instanceRoot, "runtime-artifacts"),
    path.join(targets.instanceRoot, "control"),
    path.join(targets.instanceRoot, "pending.json"),
    path.join(targets.instanceRoot, "diagnostics", "pending.json"),
    path.join(targets.instanceRoot, "update.lock"),
  ]) {
    await fs.rm(temporaryPath, { recursive: true, force: true });
  }
  return { userDataRecreated: true, appServerMutableStateCleared: true };
}

export {
  readBetaSlotMetadata,
  recordBetaSlotRecoveryAttempt,
  recordBetaSlotRelease,
} from "./beta-slot-pool-metadata.mjs";
