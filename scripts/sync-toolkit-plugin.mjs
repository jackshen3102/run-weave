#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
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
const hooksConfig = readJson(hooksConfigPath);
const marketplaceName = marketplace.name;
const pluginName = manifest.name;

if (!marketplaceName || !pluginName) {
  throw new Error("Toolkit marketplace or plugin manifest is missing name.");
}
assertToolkitHooksConfig(hooksConfig);

log(`Syncing ${pluginName}@${marketplaceName} from ${pluginRelativePath}.`);

const codexCompatibilityVersions = collectCodexCompatibilityVersions(
  pluginName,
  marketplaceName,
);

syncToolkitHookAssets();
validateCodexPlugin();
updateCodexCachebuster();
formatCodexPluginManifest();
validateCodexPlugin();
installForCodex(pluginName, marketplaceName);
preserveCodexCompatibilityCache(
  pluginName,
  marketplaceName,
  codexCompatibilityVersions,
);
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

function assertToolkitHooksConfig(hooksConfig) {
  const requiredEvents = [
    "PostToolUse",
    "SessionStart",
    "Stop",
    "SubagentStop",
    "UserPromptSubmit",
  ];
  if (!hooksConfig || typeof hooksConfig !== "object") {
    throw new Error("Toolkit hooks.json must be an object.");
  }
  if (!hooksConfig.hooks || typeof hooksConfig.hooks !== "object") {
    throw new Error("Toolkit hooks.json is missing hooks.");
  }

  for (const event of requiredEvents) {
    const entries = hooksConfig.hooks[event];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`Toolkit hooks.json is missing ${event}.`);
    }

    const commands = entries.flatMap((entry) =>
      Array.isArray(entry?.hooks)
        ? entry.hooks
            .map((hook) => hook?.command)
            .filter((command) => typeof command === "string")
        : [],
    );
    if (
      !commands.some(
        (command) =>
          command.includes("runweave-hook-dispatch.cjs") &&
          command.includes("CODEX_PLUGIN_ROOT") &&
          command.includes("__PLUGIN_DIR__"),
      )
    ) {
      throw new Error(
        `Toolkit hooks.json ${event} does not invoke the Runweave dispatcher.`,
      );
    }
  }
}

function validateCodexPlugin() {
  const validator = path.join(
    codexHome,
    "skills",
    ".system",
    "plugin-creator",
    "scripts",
    "validate_plugin.py",
  );
  assertFile(validator);
  validateCodexPluginManifest(validator);

  const skillValidator = path.join(
    codexHome,
    "skills",
    ".system",
    "skill-creator",
    "scripts",
    "quick_validate.py",
  );
  assertFile(skillValidator);
  run(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        `for skill_dir in "${pluginDir}"/skills/*; do`,
        '  [ -d "$skill_dir" ] || continue',
        `  uv run --with pyyaml python "${skillValidator}" "$skill_dir"`,
        "done",
      ].join("\n"),
    ],
    { env: withCodexHome() },
  );
}

function validateCodexPluginManifest(validator) {
  const command = "uv";
  const commandArgs = [
    "run",
    "--with",
    "pyyaml",
    "python",
    validator,
    pluginDir,
  ];
  log(`$ ${[command, ...commandArgs].map(shellQuote).join(" ")}`);
  const result = runResult(command, commandArgs, {
    env: withCodexHome(),
  });
  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (isOutdatedHooksValidatorFailure(output)) {
    log(
      "Plugin validator rejected plugin.json hooks, but this Codex runtime supports plugin hooks; continuing.",
    );
    return;
  }

  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  throw new Error(`${command} exited with status ${result.status}`);
}

function isOutdatedHooksValidatorFailure(output) {
  return output.includes(
    "plugin.json field `hooks` is not accepted by plugin validation",
  );
}

function updateCodexCachebuster() {
  const helper = path.join(
    codexHome,
    "skills",
    ".system",
    "plugin-creator",
    "scripts",
    "update_plugin_cachebuster.py",
  );
  assertFile(helper);
  run("python3", [helper, pluginDir], { env: withCodexHome() });
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

  const archiveRoot = path.join(cacheRoot, ".archive");
  replaceCodexCacheAlias(
    path.join(cacheRoot, "latest"),
    currentCachePath,
    archiveRoot,
    "latest",
  );

  for (const version of compatibilityVersions) {
    if (version === currentVersion) {
      continue;
    }

    const aliasPath = path.join(cacheRoot, version);
    if (
      !replaceCodexCacheAlias(aliasPath, currentCachePath, archiveRoot, version)
    ) {
      continue;
    }
    log(`Preserved Codex compatibility cache ${version} -> ${currentVersion}.`);
  }
}

function replaceCodexCacheAlias(
  aliasPath,
  currentCachePath,
  archiveRoot,
  label,
) {
  const aliasState = getPathState(aliasPath);
  if (aliasState === "symlink") {
    rmSync(aliasPath, { force: true });
  } else if (aliasState === "directory") {
    const archivedPath = archiveCodexCacheDirectory(aliasPath, archiveRoot);
    log(`Archived Codex plugin cache ${label} -> ${archivedPath}.`);
  } else if (aliasState === "other") {
    log(`Skipping compatibility cache alias over non-directory ${aliasPath}.`);
    return false;
  }

  symlinkSync(currentCachePath, aliasPath, "dir");
  return true;
}

function archiveCodexCacheDirectory(directoryPath, archiveRoot) {
  mkdirSync(archiveRoot, { recursive: true });
  const baseName = path.basename(directoryPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let archivePath = path.join(archiveRoot, `${baseName}-${timestamp}`);
  let index = 1;

  while (existsSync(archivePath)) {
    archivePath = path.join(archiveRoot, `${baseName}-${timestamp}-${index}`);
    index += 1;
  }

  renameSync(directoryPath, archivePath);
  return archivePath;
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

function withCodexHome() {
  return {
    ...process.env,
    CODEX_HOME: codexHome,
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required file does not exist: ${filePath}`);
  }
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
