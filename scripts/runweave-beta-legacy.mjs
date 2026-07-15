import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertBetaInstanceId,
  resolveBetaUpdateTargets,
} from "./runweave-update-core.mjs";
import {
  inspectProcessReferences,
  inspectRecordedProcessState,
  readJson,
  runCapture,
  writeJson,
} from "./runweave-beta-state.mjs";

const POOL_SLOT_PATTERN = /^pool-0[1-5]$/;
const OPERATION_ID_PATTERN = /^legacy-[0-9TZ-]+-[a-f0-9-]{36}$/;

function assertLegacyInstanceId(value) {
  const instanceId = assertBetaInstanceId(value);
  if (POOL_SLOT_PATTERN.test(instanceId)) {
    throw new Error("pool slots are not legacy cleanup targets");
  }
  return instanceId;
}

function resolveLegacyRoots(homeDir = os.homedir()) {
  const betaRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Runweave Beta",
  );
  return {
    betaRoot,
    instancesRoot: path.join(betaRoot, "instances"),
    quarantineRoot: path.join(betaRoot, "pool", "quarantine"),
    appServerRoot: path.join(homeDir, ".runweave", "app-server-beta"),
  };
}

async function assertNoSymlinkPath(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`legacy path escapes its controlled root: ${target}`);
  }
  let current = root;
  const components = path
    .relative(root, target)
    .split(path.sep)
    .filter(Boolean);
  for (const component of ["", ...components]) {
    if (component) {
      current = path.join(current, component);
    }
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
      throw new Error(`legacy controlled path contains a symlink: ${current}`);
    }
  }
}

async function readBundleId(appPath) {
  const result = await runCapture("plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
  return result.ok ? result.stdout.trim() : null;
}

async function inspectResource(targetPath) {
  const stats = await fs.lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  const diskUsage = stats ? await runCapture("du", ["-sk", targetPath]) : null;
  const kibibytes = diskUsage?.ok
    ? Number.parseInt(diskUsage.stdout.trim().split(/\s+/)[0], 10)
    : null;
  return {
    path: targetPath,
    exists: Boolean(stats),
    symlink: stats?.isSymbolicLink() ?? false,
    kind: stats?.isDirectory() ? "directory" : stats?.isFile() ? "file" : null,
    bytes: Number.isFinite(kibibytes) ? kibibytes * 1024 : null,
  };
}

async function collectLegacyInstanceIds(homeDir, applicationsDir) {
  const roots = resolveLegacyRoots(homeDir);
  const ids = new Set();
  for (const entry of await fs.readdir(roots.instancesRoot).catch(() => [])) {
    if (!POOL_SLOT_PATTERN.test(entry)) {
      try {
        ids.add(assertBetaInstanceId(entry));
      } catch {
        // Invalid directory names are reported separately by filesystem tooling.
      }
    }
  }
  for (const entry of await fs.readdir(applicationsDir).catch(() => [])) {
    const match = /^Runweave Beta (.+)\.app$/.exec(entry);
    if (match && !POOL_SLOT_PATTERN.test(match[1])) {
      try {
        ids.add(assertBetaInstanceId(match[1]));
      } catch {
        // An app outside the supported identity grammar is never mutated.
      }
    }
  }
  return [...ids].sort();
}

export async function inventoryLegacyBeta({
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
} = {}) {
  const instances = [];
  for (const instanceId of await collectLegacyInstanceIds(
    homeDir,
    applicationsDir,
  )) {
    const resolvedTargets = resolveBetaUpdateTargets(homeDir, instanceId);
    const targets = {
      ...resolvedTargets,
      appPath: path.join(applicationsDir, `${resolvedTargets.appName}.app`),
    };
    const [
      app,
      instanceRoot,
      appServerHome,
      desktop,
      backend,
      appServer,
      bundleId,
      processes,
    ] =
      await Promise.all([
        inspectResource(targets.appPath),
        inspectResource(targets.instanceRoot),
        inspectResource(targets.appServerHome),
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
        readBundleId(targets.appPath),
        inspectProcessReferences([
          targets.appPath,
          targets.instanceRoot,
          targets.userData,
          targets.appServerHome,
        ]),
      ]);
    const recordedProcesses = [desktop, backend, appServer];
    const active =
      recordedProcesses.some((processState) => processState.active) ||
      processes.active;
    const processIdentityTrusted =
      recordedProcesses.every(
        (processState) => processState.trusted || !processState.exists,
      ) &&
      processes.trusted;
    const trusted =
      !active &&
      processIdentityTrusted &&
      app.exists &&
      !app.symlink &&
      !instanceRoot.symlink &&
      !appServerHome.symlink &&
      bundleId === targets.bundleId;
    instances.push({
      instanceId,
      active,
      runningPid:
        recordedProcesses.find((processState) => processState.active)?.pid ??
        null,
      runningIdentities: processes.identities,
      processIdentityFailures: [
        ...recordedProcesses
          .filter(
            (processState) =>
              processState.exists && !processState.trusted,
          )
          .map((processState) => ({
            path: processState.path,
            reason: processState.reason,
          })),
        ...(processes.trusted
          ? []
          : [{ path: null, reason: processes.reason }]),
      ],
      trusted,
      bundleId,
      expectedBundleId: targets.bundleId,
      resources: [app, instanceRoot, appServerHome],
      suggestedCleanupCommand: trusted
        ? `node scripts/runweave-beta.mjs legacy-cleanup --instance ${instanceId} --json`
        : null,
    });
  }
  return {
    schemaVersion: 1,
    mode: "read-only-inventory",
    scannedAt: new Date().toISOString(),
    instances,
  };
}

export async function cleanupLegacyBeta({
  instanceId,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
}) {
  const safeInstanceId = assertLegacyInstanceId(instanceId);
  const inventory = await inventoryLegacyBeta({ homeDir, applicationsDir });
  const candidate = inventory.instances.find(
    (entry) => entry.instanceId === safeInstanceId,
  );
  if (!candidate) {
    throw new Error(`legacy Beta instance not found: ${safeInstanceId}`);
  }
  if (!candidate.trusted || candidate.active) {
    throw new Error(
      `legacy Beta instance is active or has untrusted identity: ${safeInstanceId}`,
    );
  }
  const roots = resolveLegacyRoots(homeDir);
  const operationId = `legacy-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}-${randomUUID()}`;
  const operationRoot = path.join(roots.quarantineRoot, operationId);
  const journalPath = path.join(operationRoot, "journal.json");
  await assertNoSymlinkPath(homeDir, operationRoot);
  for (const resource of candidate.resources.filter((entry) => entry.exists)) {
    const resourceRoot = resource.path.startsWith(path.resolve(applicationsDir))
      ? path.resolve(applicationsDir)
      : homeDir;
    await assertNoSymlinkPath(resourceRoot, resource.path);
  }
  await fs.mkdir(operationRoot, { recursive: true, mode: 0o700 });
  const entries = candidate.resources
    .filter((resource) => resource.exists)
    .map((resource, index) => ({
      originalPath: resource.path,
      quarantinePath: path.join(operationRoot, `resource-${index}`),
    }));
  if (entries.length === 0) {
    throw new Error(`legacy Beta instance has no resources: ${safeInstanceId}`);
  }
  await writeJson(journalPath, {
    schemaVersion: 1,
    operationId,
    instanceId: safeInstanceId,
    applicationsDir: path.resolve(applicationsDir),
    state: "moving",
    createdAt: new Date().toISOString(),
    entries,
  });
  const moved = [];
  try {
    for (const entry of entries) {
      await fs.rename(entry.originalPath, entry.quarantinePath);
      moved.push(entry);
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      await fs
        .rename(entry.quarantinePath, entry.originalPath)
        .catch(() => undefined);
    }
    throw error;
  }
  const result = {
    schemaVersion: 1,
    operationId,
    instanceId: safeInstanceId,
    applicationsDir: path.resolve(applicationsDir),
    state: "quarantined",
    completedAt: new Date().toISOString(),
    journalPath,
    entries,
    restoreCommand: `node scripts/runweave-beta.mjs legacy-restore --operation ${operationId} --json`,
    purgeCommand: `node scripts/runweave-beta.mjs legacy-purge --operation ${operationId} --confirm ${operationId} --json`,
  };
  await writeJson(journalPath, result);
  return result;
}

function assertOperationId(operationId) {
  if (!OPERATION_ID_PATTERN.test(operationId ?? "")) {
    throw new Error("invalid legacy operation id");
  }
  return operationId;
}

async function readOperation(operationId, homeDir, applicationsDir) {
  const safeOperationId = assertOperationId(operationId);
  const roots = resolveLegacyRoots(homeDir);
  const operationRoot = path.join(roots.quarantineRoot, safeOperationId);
  const journalPath = path.join(operationRoot, "journal.json");
  await assertNoSymlinkPath(homeDir, journalPath);
  const operationStats = await fs.lstat(operationRoot).catch(() => null);
  const journalStats = await fs.lstat(journalPath).catch(() => null);
  if (
    !operationStats?.isDirectory() ||
    operationStats.isSymbolicLink() ||
    !journalStats?.isFile() ||
    journalStats.isSymbolicLink()
  ) {
    throw new Error(
      `legacy operation path is missing or unsafe: ${safeOperationId}`,
    );
  }
  const journal = await readJson(journalPath);
  if (
    journal?.schemaVersion !== 1 ||
    journal.operationId !== safeOperationId ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error(
      `legacy operation journal is missing or invalid: ${safeOperationId}`,
    );
  }
  const safeInstanceId = assertLegacyInstanceId(journal.instanceId);
  if (
    typeof journal.applicationsDir !== "string" ||
    !path.isAbsolute(journal.applicationsDir) ||
    path.resolve(journal.applicationsDir) !== path.resolve(applicationsDir)
  ) {
    throw new Error(
      `legacy operation applications root is invalid: ${safeOperationId}`,
    );
  }
  const targets = resolveBetaUpdateTargets(homeDir, safeInstanceId);
  const expectedOriginalPaths = new Set(
    [
      path.join(journal.applicationsDir, `${targets.appName}.app`),
      targets.instanceRoot,
      targets.appServerHome,
    ].map((entry) => path.resolve(entry)),
  );
  const seenOriginalPaths = new Set();
  for (const entry of journal.entries) {
    const originalPath = path.resolve(entry?.originalPath ?? "");
    const quarantinePath = path.resolve(entry?.quarantinePath ?? "");
    if (
      !expectedOriginalPaths.has(originalPath) ||
      seenOriginalPaths.has(originalPath) ||
      (quarantinePath !== operationRoot &&
        !quarantinePath.startsWith(`${operationRoot}${path.sep}`))
    ) {
      throw new Error(
        `legacy operation journal paths are invalid: ${safeOperationId}`,
      );
    }
    seenOriginalPaths.add(originalPath);
  }
  return { journal, journalPath, operationRoot };
}

export async function restoreLegacyBeta({
  operationId,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
}) {
  const operation = await readOperation(operationId, homeDir, applicationsDir);
  if (operation.journal.state !== "quarantined") {
    throw new Error(
      `legacy operation is not restorable: ${operation.journal.state}`,
    );
  }
  for (const entry of operation.journal.entries) {
    if (await fs.lstat(entry.originalPath).catch(() => null)) {
      throw new Error(
        `legacy restore target already exists: ${entry.originalPath}`,
      );
    }
  }
  for (const entry of operation.journal.entries) {
    await fs.mkdir(path.dirname(entry.originalPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.rename(entry.quarantinePath, entry.originalPath);
  }
  const result = {
    ...operation.journal,
    state: "restored",
    restoredAt: new Date().toISOString(),
  };
  await writeJson(operation.journalPath, result);
  return result;
}

export async function purgeLegacyBeta({
  operationId,
  confirm,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
}) {
  const safeOperationId = assertOperationId(operationId);
  if (confirm !== safeOperationId) {
    throw new Error("legacy purge requires --confirm to match operation id");
  }
  const operation = await readOperation(
    safeOperationId,
    homeDir,
    applicationsDir,
  );
  if (operation.journal.state !== "quarantined") {
    throw new Error(
      `legacy operation is not purgeable: ${operation.journal.state}`,
    );
  }
  await fs.rm(operation.operationRoot, { recursive: true });
  return {
    schemaVersion: 1,
    operationId: safeOperationId,
    state: "purged",
    purgedAt: new Date().toISOString(),
  };
}
