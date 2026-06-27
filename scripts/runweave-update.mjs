import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commandName,
  parseRunweaveUpdateArgs,
  readDotenvValue,
  resolveAppBuildVersion,
  resolveDefaultRuntimeHome,
  resolveDefaultUpdateStatePath,
  resolveUpdatePlan,
  RUNWEAVE_CODESIGN_IDENTITY_ENV,
  upsertDotenvValue,
  validateResolvedUpdateOptions,
} from "./runweave-update-core.mjs";

const appName = process.env.RUNWEAVE_LOCAL_UPDATE_APP_NAME ?? "Runweave";
const codesignEnvFileRelativePath = path.join("backend", ".env");

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ ok: code === 0, code: code ?? 1, signal });
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}`,
    );
  }
}

async function runCaptureChecked(command, args, options = {}) {
  const result = await runCapture(command, args, options);
  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readPackageVersion(packagePath) {
  return readJsonFile(packagePath)?.version ?? null;
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readInstalledMacAppVersion(appPath) {
  if (process.platform !== "darwin" || !existsSync(appPath)) {
    return null;
  }

  const result = await runCapture("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist"),
  ]);

  if (!result.ok) {
    return null;
  }

  return result.stdout.trim() || null;
}

async function listCodesignIdentities() {
  if (process.platform !== "darwin") {
    return [];
  }

  const result = await runCapture("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/"([^"]+)"/)?.[1])
    .filter(Boolean);
}

async function writeCodesignIdentityConfig(configPath, rawConfig, identity) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    upsertDotenvValue(
      rawConfig ?? "",
      RUNWEAVE_CODESIGN_IDENTITY_ENV,
      identity,
    ),
  );
}

async function resolveCodesignIdentity(sourceRoot, options = {}) {
  const explicitIdentity = process.env[RUNWEAVE_CODESIGN_IDENTITY_ENV]?.trim();
  if (explicitIdentity) {
    return {
      identity: explicitIdentity,
      source: "environment",
    };
  }

  const configPath = path.join(sourceRoot, codesignEnvFileRelativePath);
  const persistConfig = options.persistConfig ?? true;
  const rawConfig = await readTextFile(configPath);
  const configuredIdentity = rawConfig
    ? readDotenvValue(rawConfig, RUNWEAVE_CODESIGN_IDENTITY_ENV)?.trim()
    : null;
  const excluded = new Set(options.exclude ?? []);
  const identities = await listCodesignIdentities();

  if (
    configuredIdentity &&
    !excluded.has(configuredIdentity) &&
    identities.includes(configuredIdentity)
  ) {
    return {
      identity: configuredIdentity,
      source: codesignEnvFileRelativePath,
    };
  }

  const nextIdentity = identities.find((identity) => !excluded.has(identity));
  if (!nextIdentity) {
    return {
      identity: null,
      source: configuredIdentity ? "unavailable-config" : "none",
    };
  }

  if (persistConfig) {
    await writeCodesignIdentityConfig(configPath, rawConfig, nextIdentity);
  }
  return {
    identity: nextIdentity,
    source: configuredIdentity
      ? persistConfig
        ? "refreshed-config"
        : "would-refresh-config"
      : persistConfig
        ? "generated-config"
        : "would-generate-config",
  };
}

async function getGitHead(sourceRoot) {
  const result = await runCapture("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
  });
  return result.ok ? result.stdout.trim() : null;
}

async function getGitStatusDirty(sourceRoot) {
  const result = await runCapture("git", ["status", "--porcelain"], {
    cwd: sourceRoot,
  });
  return result.ok && result.stdout.trim().length > 0;
}

async function getGitChangedFilesSinceState(sourceRoot, state) {
  const changed = [];
  if (state?.gitHead) {
    const committed = await runCapture(
      "git",
      ["diff", "--name-only", state.gitHead, "HEAD"],
      { cwd: sourceRoot },
    );
    if (committed.ok) {
      changed.push(...committed.stdout.split(/\r?\n/));
    } else {
      changed.push("electron/src/main.ts");
    }
  }

  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const result = await runCapture("git", args, { cwd: sourceRoot });
    if (result.ok) {
      changed.push(...result.stdout.split(/\r?\n/));
    }
  }

  return changed.map((file) => file.trim()).filter(Boolean);
}

async function getRunningAppLines() {
  const result = await runCapture("pgrep", ["-fl", appName]);

  if (!result.ok && result.code !== 1) {
    throw new Error(`pgrep failed with exit code ${result.code}`);
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes(`${appName}.app/Contents/`));
}

async function waitForAppExit() {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    if ((await getRunningAppLines()).length === 0) {
      return;
    }

    await wait(1_000);
  }

  const remaining = await getRunningAppLines();
  if (remaining.length > 0) {
    console.warn(
      "[runweave-update] force stopping remaining Runweave processes",
    );
    await run("pkill", ["-f", `${appName}.app/Contents/`]);
  }

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if ((await getRunningAppLines()).length === 0) {
      return;
    }

    await wait(1_000);
  }

  throw new Error(`${appName} did not exit cleanly`);
}

async function waitForInstalledAppStart(appPath) {
  const expectedMarker = `${appPath}/Contents/`;

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const runningLines = await getRunningAppLines();
    if (runningLines.some((line) => line.includes(expectedMarker))) {
      return;
    }

    await wait(1_000);
  }

  throw new Error(`${appName} did not start from ${appPath}`);
}

async function quitApp() {
  if (process.platform !== "darwin") {
    return;
  }

  await run("osascript", ["-e", `tell application "${appName}" to quit`]);
  await waitForAppExit();
}

async function openApp(appPath) {
  if (process.platform !== "darwin") {
    return;
  }

  await fs.access(appPath);
  await runChecked("open", ["-n", appPath]);
  await waitForInstalledAppStart(appPath);
}

async function restartApp(appPath) {
  if (process.platform !== "darwin") {
    return;
  }

  await quitApp();
  await openApp(appPath);
}

async function installBuiltApp({ appPath, releaseAppPath }) {
  if (process.platform !== "darwin") {
    return;
  }

  await fs.access(releaseAppPath);

  const appDir = path.dirname(appPath);
  const tempAppPath = path.join(
    appDir,
    `.${appName}.app.updating-${Date.now()}`,
  );

  console.log(`[runweave-update] installing ${releaseAppPath} to ${appPath}`);
  await fs.rm(tempAppPath, { force: true, recursive: true });
  await runChecked("ditto", [releaseAppPath, tempAppPath]);
  await run("xattr", ["-dr", "com.apple.quarantine", tempAppPath]);
  await fs.rm(appPath, { force: true, recursive: true });
  await fs.rename(tempAppPath, appPath);
}

async function findLatestRuntimeManifest(sourceRoot) {
  const artifactsRoot = path.join(sourceRoot, ".runtime-artifacts");
  const entries = await fs.readdir(artifactsRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactsRoot, entry.name, "manifest.json"))
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => {
      const manifest = readJsonFile(filePath);
      return {
        filePath,
        manifest,
        mtimeMs: existsSync(filePath) ? readFileSync(filePath).length : 0,
      };
    })
    .filter((candidate) => candidate.manifest?.releaseId);

  candidates.sort((a, b) =>
    String(b.manifest.createdAt ?? "").localeCompare(
      String(a.manifest.createdAt ?? ""),
    ),
  );
  return candidates[0]?.manifest ?? null;
}

async function runRuntimeUpdate({
  installedAppVersion,
  runtimeHome,
  sourceRoot,
}) {
  const releaseId = `local-${Date.now()}`;
  const shellVersionArg = installedAppVersion
    ? [`--shell-version=${installedAppVersion}`]
    : [];

  await runChecked(
    commandName("pnpm"),
    ["runtime:build", "--", `--release-id=${releaseId}`, ...shellVersionArg],
    { cwd: sourceRoot },
  );
  await runChecked(
    commandName("pnpm"),
    [
      "runtime:install",
      "--",
      "--latest",
      `--runtime-home=${runtimeHome}`,
      ...shellVersionArg,
    ],
    { cwd: sourceRoot },
  );

  return await findLatestRuntimeManifest(sourceRoot);
}

async function runAppServerUpdate({ appServerHome, sourceRoot }) {
  const releaseId = `local-app-server-${Date.now()}`;

  await runChecked(
    "node",
    [
      "./scripts/install-app-server-runtime.mjs",
      `--release-id=${releaseId}`,
      `--home=${appServerHome}`,
    ],
    { cwd: sourceRoot },
  );

  const restart = await runCaptureChecked(
    "node",
    [
      "./packages/runweave-cli/dist/index.js",
      "app-server",
      "restart",
      "--home",
      appServerHome,
    ],
    { cwd: sourceRoot },
  );

  let status = null;
  try {
    status = JSON.parse(restart.stdout);
  } catch {
    status = null;
  }

  return {
    home: appServerHome,
    releaseId,
    status,
  };
}

async function runAppUpdate({
  appBuildVersion,
  appPath,
  codesignIdentity,
  sourceRoot,
}) {
  const releaseAppPath = path.join(
    sourceRoot,
    "electron",
    "release",
    "mac-arm64",
    `${appName}.app`,
  );
  await runChecked(
    "node",
    [
      "./scripts/electron-dist-retry.mjs",
      "--config",
      "electron-builder.local-updates.yml",
      "--mac",
      "--arm64",
    ],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        RUNWEAVE_ELECTRON_BUILD_VERSION: appBuildVersion,
        ...(codesignIdentity
          ? { RUNWEAVE_CODESIGN_IDENTITY: codesignIdentity }
          : {}),
        RUNWEAVE_SKIP_ELECTRON_VERSION_BUMP: "true",
      },
    },
  );
  await quitApp();
  await installBuiltApp({ appPath, releaseAppPath });
  await openApp(appPath);
}

async function writeUpdateState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function main() {
  const args = parseRunweaveUpdateArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(args.sourceRoot);
  const appPath = path.resolve(args.appPath ?? `/Applications/${appName}.app`);
  const runtimeHome = path.resolve(
    args.runtimeHome ??
      process.env.RUNWEAVE_RUNTIME_HOME ??
      resolveDefaultRuntimeHome(),
  );
  const appServerHome = path.resolve(
    args.appServerHome ??
      process.env.RUNWEAVE_APP_SERVER_HOME ??
      path.join(os.homedir(), ".runweave", "app-server"),
  );
  const statePath = path.resolve(
    args.statePath ??
      process.env.RUNWEAVE_UPDATE_STATE_PATH ??
      resolveDefaultUpdateStatePath(),
  );
  const state = readJsonFile(statePath);
  const sourceShellVersion = readPackageVersion(
    path.join(sourceRoot, "electron", "package.json"),
  );
  const installedAppVersion = await readInstalledMacAppVersion(appPath);
  const changedFiles = await getGitChangedFilesSinceState(sourceRoot, state);
  const plan = resolveUpdatePlan({
    appServerMode: args.appServerMode,
    changedFiles,
    forceMode: args.mode,
    hasPreviousAppServerState: Boolean(
      state?.appServerReleaseId ??
        state?.appServer?.releaseId ??
        state?.appServer?.action,
    ),
    hasPreviousState: Boolean(state?.gitHead),
    installedAppVersion,
    sourceShellVersion,
  });
  validateResolvedUpdateOptions({ noRestart: args.noRestart, plan });
  const gitHead = await getGitHead(sourceRoot);
  const gitDirty = await getGitStatusDirty(sourceRoot);
  let codesignIdentity = await resolveCodesignIdentity(sourceRoot, {
    persistConfig: !args.dryRun,
  });
  const appBuildVersion = resolveAppBuildVersion({
    installedAppVersion,
    sourceShellVersion,
  });

  console.log(`[runweave-update] source: ${sourceRoot}`);
  console.log(`[runweave-update] installed app: ${appPath}`);
  console.log(
    `[runweave-update] installed version: ${installedAppVersion ?? "unknown"}`,
  );
  console.log(
    `[runweave-update] source shell version: ${sourceShellVersion ?? "unknown"}`,
  );
  console.log(`[runweave-update] selected mode: ${plan.mode}`);
  console.log(`[runweave-update] reason: ${plan.reason}`);
  console.log(`[runweave-update] app-server home: ${appServerHome}`);
  console.log(
    `[runweave-update] selected app-server action: ${plan.appServer.action}`,
  );
  console.log(`[runweave-update] app-server reason: ${plan.appServer.reason}`);
  if (plan.mode === "app") {
    console.log(
      `[runweave-update] codesign identity: ${codesignIdentity.identity ?? "ad-hoc"} (${codesignIdentity.source})`,
    );
  }
  if (plan.nativeFiles.length > 0) {
    console.log(
      `[runweave-update] native-sensitive changes: ${plan.nativeFiles.join(", ")}`,
    );
  }
  if (plan.appServer.changedFiles.length > 0) {
    console.log(
      `[runweave-update] app-server changes: ${plan.appServer.changedFiles.join(", ")}`,
    );
  }

  if (args.dryRun) {
    console.log("[runweave-update] dry run complete");
    return;
  }

  let runtimeRelease = null;
  let appServerRelease = null;
  const previousAppServerReleaseId =
    state?.appServerReleaseId ?? state?.appServer?.releaseId ?? null;
  if (plan.mode === "runtime") {
    runtimeRelease = await runRuntimeUpdate({
      installedAppVersion,
      runtimeHome,
      sourceRoot,
    });
    if (!args.noRestart) {
      await restartApp(appPath);
    }
  } else {
    try {
      await runAppUpdate({
        appBuildVersion,
        appPath,
        codesignIdentity: codesignIdentity.identity,
        sourceRoot,
      });
    } catch (error) {
      if (!codesignIdentity.identity) {
        throw error;
      }
      console.warn(
        `[runweave-update] app update failed with codesign identity ${codesignIdentity.identity}; refreshing identity once`,
      );
      codesignIdentity = await resolveCodesignIdentity(sourceRoot, {
        exclude: [codesignIdentity.identity],
      });
      if (!codesignIdentity.identity) {
        throw error;
      }
      await runAppUpdate({
        appBuildVersion,
        appPath,
        codesignIdentity: codesignIdentity.identity,
        sourceRoot,
      });
    }
  }
  if (plan.appServer.action === "update") {
    appServerRelease = await runAppServerUpdate({
      appServerHome,
      sourceRoot,
    });
  }

  const nextInstalledVersion = await readInstalledMacAppVersion(appPath);
  await writeUpdateState(statePath, {
    appServer: {
      action: plan.appServer.action,
      changedFiles: plan.appServer.changedFiles,
      home: appServerHome,
      reason: plan.appServer.reason,
      releaseId: appServerRelease?.releaseId ?? previousAppServerReleaseId,
      status: appServerRelease?.status ?? null,
    },
    appServerAction: plan.appServer.action,
    appServerHome,
    appServerReason: plan.appServer.reason,
    appServerReleaseId: appServerRelease?.releaseId ?? previousAppServerReleaseId,
    appPath,
    appVersion: nextInstalledVersion ?? installedAppVersion,
    gitDirty,
    gitHead,
    mode: plan.mode,
    nativeFiles: plan.nativeFiles,
    reason: plan.reason,
    codesignIdentity: plan.mode === "app" ? codesignIdentity.identity : null,
    codesignIdentitySource:
      plan.mode === "app" ? codesignIdentity.source : null,
    runtimeHome,
    runtimeReleaseId: runtimeRelease?.releaseId ?? null,
    sourceRoot,
    updatedAt: new Date().toISOString(),
  });

  console.log("[runweave-update] done");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
