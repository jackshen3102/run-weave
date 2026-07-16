import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isPidLive,
  readJson,
  runCapture,
  writeJson,
} from "./runweave-beta-state.mjs";
import { quitBeta, runAppServerCli } from "./runweave-beta-operations.mjs";

async function copyMigrationEntry(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (process.platform === "darwin") {
    const result = await runCapture("ditto", [source, target]);
    if (!result.ok) {
      throw new Error(`failed to copy ${source}: ${result.stderr}`);
    }
    return;
  }
  await fs.cp(source, target, { recursive: true, errorOnExist: true });
}

async function readBundlePlistValue(appPath, key) {
  const result = await runCapture("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
  return result.ok ? result.stdout.trim() : null;
}

export async function migrateLegacyDefault(paths, update) {
  if (paths.instanceId !== "default") {
    throw new Error("legacy migration is only supported for default");
  }
  const legacyAppPath = "/Applications/Runweave Beta.app";
  const legacyUserData = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Runweave Beta",
  );
  const legacyStatus = await readJson(
    path.join(legacyUserData, "beta-desktop-status.json"),
  );
  const legacyProcesses = await runCapture("pgrep", ["-fl", "Runweave Beta"]);
  const legacyAppRunning = legacyProcesses.stdout
    .split(/\r?\n/)
    .some((line) => line.includes(`${legacyAppPath}/Contents/`));
  if (isPidLive(legacyStatus?.app?.pid) || legacyAppRunning) {
    throw new Error(
      "legacy Beta appears to be running; stop and verify it before migration",
    );
  }
  const entries = [];
  if (await fs.stat(legacyAppPath).catch(() => null)) {
    entries.push({
      label: "app",
      source: legacyAppPath,
      commit: false,
    });
  }
  for (const entry of [
    "beta-desktop-status.json",
    "browser-profile",
    "cli",
    "runtime",
    "update",
  ]) {
    const source = path.join(legacyUserData, entry);
    const target = path.join(paths.userData, entry);
    if (await fs.stat(source).catch(() => null)) {
      entries.push({
        label: `user-data-${entry}`,
        source,
        target,
        commit: !["beta-desktop-status.json", "update"].includes(entry),
      });
    }
  }
  const legacyAppServerHome = path.join(
    os.homedir(),
    ".runweave",
    "app-server-beta",
  );
  for (const entry of [
    "app-server-events.jsonl",
    "app-server-token",
    "cloud-sync",
    "runtime",
  ]) {
    const source = path.join(legacyAppServerHome, entry);
    const target = path.join(paths.appServerHome, entry);
    if (await fs.stat(source).catch(() => null)) {
      entries.push({
        label: `app-server-${entry}`,
        source,
        target,
        commit: true,
      });
    }
  }
  if (entries.length === 0) {
    throw new Error("no legacy default Beta state was found to migrate");
  }
  for (const targetRoot of [
    paths.appPath,
    paths.userData,
    paths.appServerHome,
  ]) {
    if (await fs.stat(targetRoot).catch(() => null)) {
      throw new Error(`migration target already exists: ${targetRoot}`);
    }
  }
  const migrationId = new Date().toISOString().replace(/[:.]/g, "-");
  const migrationRoot = path.join(
    paths.instanceRoot,
    "migrations",
    migrationId,
  );
  const journalPath = path.join(migrationRoot, "journal.json");
  const planned = entries.map((entry) => ({
    ...entry,
    backup: path.join(migrationRoot, "backup", entry.label),
  }));
  await writeJson(journalPath, {
    schemaVersion: 1,
    instanceId: paths.instanceId,
    state: "backing-up",
    startedAt: new Date().toISOString(),
    entries: planned,
  });
  for (const entry of planned) {
    await copyMigrationEntry(entry.source, entry.backup);
  }
  await writeJson(journalPath, {
    schemaVersion: 1,
    instanceId: paths.instanceId,
    state: "committing",
    startedAt: new Date().toISOString(),
    entries: planned,
  });
  try {
    for (const entry of planned.filter((candidate) => candidate.commit)) {
      await copyMigrationEntry(entry.backup, entry.target);
    }
    const status = await update(
      paths,
      ["--mode", "app", "--app-server", "update"],
      { throwOnFailure: true },
    );
    const [bundleId, bundleName, state] = await Promise.all([
      readBundlePlistValue(paths.appPath, "CFBundleIdentifier"),
      readBundlePlistValue(paths.appPath, "CFBundleName"),
      readJson(paths.statePath),
    ]);
    if (
      bundleId !== paths.bundleId ||
      bundleName !== paths.appName ||
      state?.mode !== "app" ||
      status?.instanceId !== paths.instanceId ||
      status?.desktop?.appPath !== paths.appPath ||
      status?.desktop?.userDataPath !== paths.userData ||
      status?.desktop?.healthy !== true
    ) {
      throw new Error("migrated Beta instance identity verification failed");
    }
  } catch (error) {
    await quitBeta(paths).catch(() => undefined);
    await runAppServerCli(paths, "stop").catch(() => undefined);
    for (const targetRoot of [
      paths.appPath,
      paths.userData,
      paths.appServerHome,
      paths.buildRoot,
      path.dirname(paths.controlCliPath),
      paths.runtimeArtifactsRoot,
    ]) {
      await fs.rm(targetRoot, { force: true, recursive: true });
    }
    await writeJson(journalPath, {
      schemaVersion: 1,
      instanceId: paths.instanceId,
      state: "rolled-back",
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      entries: planned,
    });
    throw error;
  }
  const result = {
    schemaVersion: 1,
    instanceId: paths.instanceId,
    state: "completed",
    completedAt: new Date().toISOString(),
    legacyPreserved: true,
    entries: planned,
    journalPath,
  };
  await writeJson(journalPath, result);
  console.log(JSON.stringify(result, null, 2));
}
