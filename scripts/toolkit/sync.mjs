#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { buildAgentAssets } from "../agents/build.mjs";
import {
  bridgeAssets,
  installPi,
} from "../../packages/agent-bridge/src/install-pi.mjs";
import { homedir } from "node:os";
import path from "node:path";
import {
  assertFile,
  commandExists,
  log,
  readJson,
  repoRoot,
  run,
  runCapture,
  runOptional,
  runResult,
} from "./sync-runtime.mjs";
import { codexReleaseInstalled, collectSessionReferencedCodexVersions } from "./codex-state.mjs";
import {
  lockToolkitSync,
  packageMatches,
  publishToolkitRelease,
  toolkitRelease,
} from "./release.mjs";

const args = new Set(process.argv.slice(2));
const ifStaged = args.has("--if-staged");
const shouldStageAssets = ifStaged || args.has("--stage-cachebuster");

const pluginRelativePath = "plugins/toolkit";
const marketplaceRelativePath = ".agents/plugins/marketplace.json";
const pluginDir = path.join(repoRoot, pluginRelativePath);
const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
const hooksConfigPath = path.join(pluginDir, "hooks.json");
const marketplacePath = path.join(repoRoot, marketplaceRelativePath);
const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const traeHome = path.join(homedir(), ".trae");
const publishRoot = path.join(codexHome, "plugins", "sources", "runweave");
let publishedPluginDir;
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

const primaryWorktree = runCapture(
  "git",
  ["worktree", "list", "--porcelain", "-z"],
  { quiet: true },
)
  .split("\0")[0]
  .slice("worktree ".length);
if (ifStaged && repoRoot !== primaryWorktree) {
  // A linked branch may contain an older Toolkit. A commit must not downgrade the user's global install.
  await buildAgentAssets();
  stageGeneratedAssets();
  log(
    "Linked-worktree commit: generated local assets only. Use pnpm toolkit:sync to explicitly publish this branch.",
  );
  process.exit(0);
}

const releaseLock = await lockToolkitSync(codexHome, log);
process.once("exit", releaseLock);

await buildAgentAssets();
await installPi({
  agentDir:
    process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"),
  assetsDir: path.join(repoRoot, "plugins", "pi", "dist"),
});
const release = toolkitRelease(repoRoot);
publishedPluginDir = publishToolkitRelease(publishRoot, marketplace, release);
log(`Toolkit content release ${release.version}.`);

if (codexReleaseInstalled(release, { marketplaceName, pluginName, publishRoot, cacheRoot: getCodexPluginCacheRoot(pluginName, marketplaceName) })) {
  log(
    "Codex already has this exact Toolkit content; leaving its installation and hook approval unchanged.",
  );
} else {
  const codexCompatibilityVersions = collectCodexCompatibilityVersions(
    pluginName,
    marketplaceName,
  );
  const codexCacheSnapshot = snapshotCodexCompatibilityCache(
    pluginName,
    marketplaceName,
    codexCompatibilityVersions,
  );

  installForCodex(pluginName, marketplaceName);
  preserveCodexCompatibilityCache(
    pluginName,
    marketplaceName,
    codexCompatibilityVersions,
    codexCacheSnapshot,
  );
  cleanupCompatibilitySnapshot(codexCacheSnapshot);
}

if (
  packageMatches(
    path.join(getTraePluginCacheRoot(pluginName), release.version),
    release.files,
  )
) {
  log(
    "Trae already has this exact Toolkit content; leaving its installation unchanged.",
  );
} else {
  const traeCacheSnapshot = snapshotTraeCompatibilityCache(pluginName);
  try {
    installForTrae(pluginName);
  } finally {
    preserveTraeCompatibilityCache(pluginName, traeCacheSnapshot);
    cleanupCompatibilitySnapshot(traeCacheSnapshot);
  }
}

stageGeneratedAssets();

function stageGeneratedAssets() {
  if (shouldStageAssets) {
    run("git", [
      "add",
      path.relative(repoRoot, hooksConfigPath),
      ...bridgeAssets.flatMap((asset) => [
        `plugins/toolkit/hooks/${asset}`,
        `electron/resources/hooks/${asset}`,
      ]),
      "electron/resources/hooks/runweave-hook-dispatch.cjs",
      "electron/resources/hooks/pi",
    ]);
  }
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
      "packages/agent-bridge",
      "scripts/agents",
      "scripts/toolkit",
      marketplaceRelativePath,
    ],
    { quiet: true },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return output.length > 0;
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
    codexHome,
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


function preserveCodexCompatibilityCache(
  pluginName,
  marketplaceName,
  compatibilityVersions,
  cacheSnapshot,
) {
  const currentVersion = readJson(
    path.join(publishedPluginDir, ".codex-plugin/plugin.json"),
  ).version;
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

function cleanupCompatibilitySnapshot(cacheSnapshot) {
  if (!cacheSnapshot?.root) {
    return;
  }
  rmSync(cacheSnapshot.root, { recursive: true, force: true });
}

function getCodexPluginCacheRoot(pluginName, marketplaceName) {
  return path.join(codexHome, "plugins", "cache", marketplaceName, pluginName);
}

function snapshotTraeCompatibilityCache(pluginName) {
  const cacheRoot = getTraePluginCacheRoot(pluginName);
  const snapshotRoot = path.join(
    traeHome,
    ".tmp",
    `toolkit-cache-snapshot-${Date.now()}-${process.pid}`,
  );
  const versions = new Set();
  const snapshots = new Map();

  for (const entry of listDirectoryNames(cacheRoot)) {
    addVersion(versions, entry);
  }
  for (const version of versions) {
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
      log(`Snapshotted Trae plugin cache ${version}.`);
    } catch (error) {
      rmSync(snapshotRoot, { recursive: true, force: true });
      throw new Error(
        `Failed to snapshot Trae plugin cache ${version}: ${error.message}`,
      );
    }
  }

  if (snapshots.size === 0) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    return { root: null, snapshots };
  }
  return { root: snapshotRoot, snapshots };
}

function preserveTraeCompatibilityCache(pluginName, cacheSnapshot) {
  const currentVersion = readJson(
    path.join(publishedPluginDir, ".codex-plugin/plugin.json"),
  ).version;
  if (!currentVersion) {
    throw new Error("Toolkit plugin manifest is missing version.");
  }

  const cacheRoot = getTraePluginCacheRoot(pluginName);
  for (const [version, snapshotPath] of cacheSnapshot.snapshots) {
    if (version === currentVersion) {
      continue;
    }

    const versionPath = path.join(cacheRoot, version);
    const versionState = getPathState(versionPath);
    if (versionState === "directory") {
      log(`Keeping existing Trae compatibility cache ${version}.`);
      continue;
    }
    if (versionState === "symlink") {
      rmSync(versionPath, { force: true });
    } else if (versionState === "other") {
      log(`Skipping compatibility cache over non-directory ${versionPath}.`);
      continue;
    }

    mkdirSync(cacheRoot, { recursive: true });
    cpSync(snapshotPath, versionPath, {
      recursive: true,
      dereference: true,
      force: true,
    });
    log(`Restored historical Trae compatibility cache ${version}.`);
  }
}

function getTraePluginCacheRoot(pluginName) {
  return path.join(traeHome, "plugins", "cache", "local", pluginName);
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
  if (
    typeof version === "string" &&
    /^[0-9]+\.[0-9]+\.[0-9]+\+codex\.(?:[0-9]+|[a-f0-9]{64})$/.test(version)
  ) {
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
    publishRoot,
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
    `Moving Codex marketplace ${marketplaceName} to its shared, worktree-independent release source.`,
  );
  runOptional("codex", [
    "plugin",
    "remove",
    `${pluginName}@${marketplaceName}`,
  ]);
  runOptional("codex", ["plugin", "marketplace", "remove", marketplaceName]);
  run("codex", ["plugin", "marketplace", "add", publishRoot]);
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
    publishedPluginDir,
  ]);
  const listing = runCapture(traeCommand, ["plugin", "list"], { quiet: true });
  if (!listing.includes(`${pluginName}@local`)) {
    throw new Error(`Trae plugin list does not include ${pluginName}@local.`);
  }
}
