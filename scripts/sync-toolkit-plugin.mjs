#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const ifStaged = args.has("--if-staged");
const shouldStageCachebuster = ifStaged || args.has("--stage-cachebuster");

const repoRoot = runCapture("git", ["rev-parse", "--show-toplevel"], {
  quiet: true,
}).trim();
const pluginRelativePath = "plugins/toolkit";
const marketplaceRelativePath = ".agents/plugins/marketplace.json";
const pluginDir = path.join(repoRoot, pluginRelativePath);
const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
const hooksConfigPath = path.join(pluginDir, "hooks.json");
const toolkitHooksDir = path.join(pluginDir, "hooks");
const electronHooksDir = path.join(repoRoot, "electron", "resources", "hooks");
const toolkitHookAssets = [
  "app-server-client.cjs",
  "feishu_stop_notify.sh",
  "runweave-hook-bridge.cjs",
  "runweave-hook-dispatch.cjs",
  "runweave-hook-payload.cjs",
];
const marketplacePath = path.join(repoRoot, marketplaceRelativePath);
const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const syncDisabled = process.env.RUNWEAVE_SKIP_TOOLKIT_PLUGIN_SYNC === "1";

if (syncDisabled) {
  log("RUNWEAVE_SKIP_TOOLKIT_PLUGIN_SYNC=1; skipping Toolkit plugin sync.");
  process.exit(0);
}

if (ifStaged && !hasStagedToolkitChanges()) {
  log("No staged Toolkit plugin changes detected; skipping sync.");
  process.exit(0);
}

assertFile(manifestPath);
assertFile(hooksConfigPath);
assertFile(marketplacePath);

const marketplace = readJson(marketplacePath);
const manifest = readJson(manifestPath);
const marketplaceName = marketplace.name;
const pluginName = manifest.name;

if (!marketplaceName || !pluginName) {
  throw new Error("Toolkit marketplace or plugin manifest is missing name.");
}

log(`Syncing ${pluginName}@${marketplaceName} from ${pluginRelativePath}.`);

const codexCompatibilityVersions = collectCodexCompatibilityVersions(
  pluginName,
  marketplaceName,
);
const codexCacheSnapshot = snapshotCodexCompatibilityCache(
  pluginName,
  marketplaceName,
  codexCompatibilityVersions,
);

syncToolkitHookAssets();
updateCodexCachebuster();
formatCodexPluginManifest();
installForCodex(pluginName, marketplaceName);
preserveCodexCompatibilityCache(
  pluginName,
  marketplaceName,
  codexCompatibilityVersions,
  codexCacheSnapshot,
);
cleanupCodexCompatibilitySnapshot(codexCacheSnapshot);
installForTrae(pluginName);

if (shouldStageCachebuster) {
  run("git", [
    "add",
    path.relative(repoRoot, manifestPath),
    path.relative(repoRoot, hooksConfigPath),
    ...toolkitHookAssets.map((asset) =>
      path.relative(repoRoot, path.join(electronHooksDir, asset)),
    ),
  ]);
}

log(
  "Toolkit plugin sync complete. New Codex/Trae sessions are required to load updated skills.",
);

function hasStagedToolkitChanges() {
  const output = runCapture(
    "git",
    [
      "diff",
      "--cached",
      "--name-only",
      "--",
      pluginRelativePath,
      marketplaceRelativePath,
    ],
    { quiet: true },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return output.length > 0;
}

function syncToolkitHookAssets() {
  mkdirSync(electronHooksDir, { recursive: true });
  for (const asset of toolkitHookAssets) {
    const source = path.join(toolkitHooksDir, asset);
    if (!existsSync(source)) {
      continue;
    }

    copyFileSync(source, path.join(electronHooksDir, asset));
  }
}

function updateCodexCachebuster() {
  const currentManifest = readJson(manifestPath);
  const baseVersion = getBasePluginVersion(currentManifest.version);
  currentManifest.version = `${baseVersion}+codex.${formatCodexTimestamp(
    new Date(),
  )}`;
  writeJson(manifestPath, currentManifest);
  log(`Updated Toolkit cachebuster to ${currentManifest.version}.`);
}

function formatCodexPluginManifest() {
  run("pnpm", [
    "exec",
    "prettier",
    "--write",
    "--parser",
    "json",
    path.relative(repoRoot, manifestPath),
  ]);
}

function installForCodex(pluginName, marketplaceName) {
  if (!commandExists("codex")) {
    log("codex not found; skipping Codex plugin install.");
    return;
  }

  ensureCodexMarketplace(pluginName, marketplaceName);
  run("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`]);
  const listing = runCapture("codex", ["plugin", "list", "--json"], {
    quiet: true,
  });
  if (!listing.includes(`${pluginName}@${marketplaceName}`)) {
    throw new Error(
      `Codex plugin list does not include ${pluginName}@${marketplaceName}.`,
    );
  }
}

function collectCodexCompatibilityVersions(pluginName, marketplaceName) {
  const versions = new Set();
  addVersion(versions, manifest.version);

  const cacheRoot = getCodexPluginCacheRoot(pluginName, marketplaceName);
  for (const entry of listDirectoryNames(cacheRoot)) {
    addVersion(versions, entry);
  }
  for (const version of collectSessionReferencedCodexVersions(
    pluginName,
    marketplaceName,
  )) {
    addVersion(versions, version);
  }

  const manifestRevisions = runCapture(
    "git",
    ["log", "--format=%H", "--", path.relative(repoRoot, manifestPath)],
    { quiet: true },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
  for (const revision of manifestRevisions) {
    const content = runCapture(
      "git",
      ["show", `${revision}:${path.relative(repoRoot, manifestPath)}`],
      { quiet: true },
    );
    addVersion(versions, parseJsonVersion(content));
  }

  return versions;
}

function collectSessionReferencedCodexVersions(pluginName, marketplaceName) {
  if (!commandExists("rg")) {
    return [];
  }

  const sessionsDir = path.join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const pattern = [
    "plugins/cache",
    marketplaceName,
    pluginName,
    "0\\.1\\.0\\+codex\\.[0-9]+",
  ].join("/");
  const result = runResult(
    "rg",
    [
      "--only-matching",
      "--no-filename",
      "--color",
      "never",
      pattern,
      sessionsDir,
    ],
    { quiet: true },
  );
  if (result.status !== 0 && result.status !== 1) {
    return [];
  }

  const versionPattern = /0\.1\.0\+codex\.[0-9]+/g;
  return Array.from(
    new Set(`${result.stdout || ""}`.match(versionPattern) ?? []),
  );
}

function preserveCodexCompatibilityCache(
  pluginName,
  marketplaceName,
  compatibilityVersions,
  cacheSnapshot,
) {
  const currentVersion = readJson(manifestPath).version;
  if (!currentVersion) {
    throw new Error("Toolkit plugin manifest is missing version.");
  }

  const cacheRoot = getCodexPluginCacheRoot(pluginName, marketplaceName);
  const currentCachePath = path.join(cacheRoot, currentVersion);
  if (!existsSync(currentCachePath)) {
    log(
      `Codex plugin cache ${currentCachePath} does not exist; skipping compatibility cache aliases.`,
    );
    return;
  }

  updateCodexLatestCacheAlias(cacheRoot, currentCachePath);

  for (const version of compatibilityVersions) {
    if (version === currentVersion) {
      continue;
    }

    const versionPath = path.join(cacheRoot, version);
    if (
      !restoreCodexCompatibilityCacheVersion(
        versionPath,
        cacheSnapshot?.snapshots?.get(version),
        currentCachePath,
        version,
      )
    ) {
      continue;
    }
  }
}

function snapshotCodexCompatibilityCache(
  pluginName,
  marketplaceName,
  compatibilityVersions,
) {
  const cacheRoot = getCodexPluginCacheRoot(pluginName, marketplaceName);
  const snapshotRoot = path.join(
    codexHome,
    ".tmp",
    `toolkit-cache-snapshot-${Date.now()}-${process.pid}`,
  );
  const snapshots = new Map();

  for (const version of compatibilityVersions) {
    const sourcePath = path.join(cacheRoot, version);
    const sourceState = getPathState(sourcePath);
    if (sourceState !== "directory" && sourceState !== "symlink") {
      continue;
    }

    mkdirSync(snapshotRoot, { recursive: true });
    const snapshotPath = path.join(snapshotRoot, version);
    try {
      cpSync(sourcePath, snapshotPath, {
        recursive: true,
        dereference: true,
        force: true,
      });
      snapshots.set(version, snapshotPath);
      log(`Snapshotted Codex plugin cache ${version}.`);
    } catch (error) {
      log(`Failed to snapshot Codex plugin cache ${version}: ${error.message}`);
    }
  }

  if (snapshots.size === 0) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    return { root: null, snapshots };
  }

  return { root: snapshotRoot, snapshots };
}

function restoreCodexCompatibilityCacheVersion(
  versionPath,
  snapshotPath,
  currentCachePath,
  version,
) {
  const versionState = getPathState(versionPath);
  if (versionState === "directory") {
    log(`Keeping existing Codex compatibility cache ${version}.`);
    return true;
  }
  if (versionState === "symlink") {
    rmSync(versionPath, { force: true });
  } else if (versionState === "other") {
    log(`Skipping compatibility cache over non-directory ${versionPath}.`);
    return false;
  }

  const sourcePath =
    typeof snapshotPath === "string" && existsSync(snapshotPath)
      ? snapshotPath
      : currentCachePath;
  cpSync(sourcePath, versionPath, {
    recursive: true,
    dereference: true,
    force: true,
  });

  if (sourcePath === currentCachePath) {
    log(`Backfilled Codex compatibility cache ${version} from current cache.`);
  } else {
    log(`Restored historical Codex compatibility cache ${version}.`);
  }
  return true;
}

function updateCodexLatestCacheAlias(cacheRoot, currentCachePath) {
  const latestPath = path.join(cacheRoot, "latest");
  const latestState = getPathState(latestPath);
  if (latestState !== "missing") {
    rmSync(latestPath, { recursive: true, force: true });
  }
  symlinkSync(currentCachePath, latestPath, "dir");
}

function cleanupCodexCompatibilitySnapshot(cacheSnapshot) {
  if (!cacheSnapshot?.root) {
    return;
  }
  rmSync(cacheSnapshot.root, { recursive: true, force: true });
}

function getCodexPluginCacheRoot(pluginName, marketplaceName) {
  return path.join(codexHome, "plugins", "cache", marketplaceName, pluginName);
}

function listDirectoryNames(directoryPath) {
  if (!existsSync(directoryPath)) {
    return [];
  }
  return runCapture(
    "find",
    [directoryPath, "-maxdepth", "1", "-mindepth", "1"],
    {
      quiet: true,
    },
  )
    .split("\n")
    .map((entry) => path.basename(entry.trim()))
    .filter(Boolean);
}

function addVersion(versions, version) {
  if (typeof version === "string" && version.startsWith("0.1.0+codex.")) {
    versions.add(version);
  }
}

function parseJsonVersion(content) {
  try {
    return JSON.parse(content).version;
  } catch {
    return null;
  }
}

function getPathState(targetPath) {
  try {
    const stats = lstatSync(targetPath);
    if (stats.isSymbolicLink()) {
      return "symlink";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
    return "other";
  } catch {
    return "missing";
  }
}

function ensureCodexMarketplace(pluginName, marketplaceName) {
  const addResult = runResult("codex", [
    "plugin",
    "marketplace",
    "add",
    repoRoot,
  ]);
  if (addResult.status === 0) {
    return;
  }

  const output = `${addResult.stdout}\n${addResult.stderr}`;
  if (!output.includes("is already added from a different source")) {
    process.stdout.write(addResult.stdout || "");
    process.stderr.write(addResult.stderr || "");
    throw new Error(`codex exited with status ${addResult.status}`);
  }

  log(
    `Codex marketplace ${marketplaceName} points at another source; replacing it with this repo.`,
  );
  runOptional("codex", [
    "plugin",
    "remove",
    `${pluginName}@${marketplaceName}`,
  ]);
  runOptional("codex", ["plugin", "marketplace", "remove", marketplaceName]);
  run("codex", ["plugin", "marketplace", "add", repoRoot]);
}

function installForTrae(pluginName) {
  const traeCommand = commandExists("traecli")
    ? "traecli"
    : commandExists("traex")
      ? "traex"
      : null;

  if (!traeCommand) {
    log("traecli/traex not found; skipping Trae plugin install.");
    return;
  }

  run(traeCommand, [
    "plugin",
    "install",
    "--type",
    "local",
    "--name",
    pluginName,
    "--marketplace-name",
    "local",
    "--yes",
    pluginDir,
  ]);
  const listing = runCapture(traeCommand, ["plugin", "list"], { quiet: true });
  if (!listing.includes(`${pluginName}@local`)) {
    throw new Error(`Trae plugin list does not include ${pluginName}@local.`);
  }
}

function commandExists(command) {
  const result = spawnSync(
    "bash",
    ["-lc", `command -v ${shellQuote(command)}`],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  return result.status === 0;
}

function run(command, commandArgs, options = {}) {
  log(`$ ${[command, ...commandArgs].map(shellQuote).join(" ")}`);
  const result = runResult(command, commandArgs, {
    ...options,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function runOptional(command, commandArgs, options = {}) {
  log(`$ ${[command, ...commandArgs].map(shellQuote).join(" ")} || true`);
  const result = runResult(command, commandArgs, options);
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) {
      log(output);
    }
  }
}

function runResult(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
}

function runCapture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    if (!options.quiet) {
      process.stderr.write(result.stderr || "");
      process.stdout.write(result.stdout || "");
    }
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required file does not exist: ${filePath}`);
  }
}

function getBasePluginVersion(version) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("plugin.json version must be a non-empty string.");
  }
  return version.split("+codex.")[0];
}

function formatCodexTimestamp(date) {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  return parts
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join("");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function log(message) {
  console.log(`[toolkit-sync] ${message}`);
}
