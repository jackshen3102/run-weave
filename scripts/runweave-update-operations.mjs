import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { commandName } from "./runweave-update-core.mjs";
import { appName, electronBuilderConfig } from "./runweave-update-context.mjs";
import {
  readJsonFile,
  run,
  runCapture,
  runCaptureChecked,
  runChecked,
  wait,
} from "./runweave-update-system.mjs";

export async function getRunningAppLines() {
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

export async function waitForAppExit() {
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

export async function waitForInstalledAppStart(appPath) {
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

export async function quitApp() {
  if (process.platform !== "darwin") {
    return;
  }

  await run("osascript", ["-e", `tell application "${appName}" to quit`]);
  await waitForAppExit();
}

export async function openApp(appPath) {
  if (process.platform !== "darwin") {
    return;
  }

  await fs.access(appPath);
  if (
    process.env.RUNWEAVE_MANAGES_PACKAGED_BACKEND === "false" ||
    process.env.RUNWEAVE_APP_SERVER_DISCOVERY === "explicit"
  ) {
    const executable = path.join(appPath, "Contents", "MacOS", appName);
    await fs.access(executable);
    const child = spawn(executable, [], {
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    child.unref();
  } else {
    await runChecked("open", ["-n", appPath]);
  }
  await waitForInstalledAppStart(appPath);
}

export async function restartApp(appPath) {
  if (process.platform !== "darwin") {
    return;
  }

  await quitApp();
  await openApp(appPath);
}

export async function installBuiltApp({
  appBackupPath,
  appPath,
  releaseAppPath,
}) {
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
  if (!appBackupPath) {
    await fs.rm(appPath, { force: true, recursive: true });
    await fs.rename(tempAppPath, appPath);
    return;
  }

  const hadInstalledApp = existsSync(appPath);
  if (hadInstalledApp) {
    if (existsSync(appBackupPath)) {
      await fs.rm(appPath, { force: true, recursive: true });
    } else {
      await fs.rename(appPath, appBackupPath);
    }
  }
  try {
    await fs.rename(tempAppPath, appPath);
  } catch (error) {
    if (hadInstalledApp && existsSync(appBackupPath)) {
      await fs.rename(appBackupPath, appPath);
    }
    throw error;
  }
}

export async function runRuntimeUpdate({
  channel,
  gitHead,
  installedAppVersion,
  runtimeHome,
  sourceRoot,
}) {
  const releaseId = `local-${Date.now()}`;
  const shellVersionArg = installedAppVersion
    ? [`--shell-version=${installedAppVersion}`]
    : [];

  const artifactsRoot = path.resolve(
    process.env.RUNWEAVE_RUNTIME_ARTIFACTS_ROOT ??
      path.join(sourceRoot, ".runtime-artifacts"),
  );
  const runtimeZipPath = path.join(
    artifactsRoot,
    `runweave-runtime-${releaseId}.zip`,
  );
  const runtimeManifestPath = path.join(
    artifactsRoot,
    releaseId,
    "manifest.json",
  );
  await runChecked(
    commandName("pnpm"),
    ["runtime:build", "--", `--release-id=${releaseId}`, ...shellVersionArg],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        VITE_RUNWEAVE_CHANNEL: channel,
        VITE_RUNWEAVE_SOURCE_REVISION: gitHead ?? "unknown",
        VITE_RUNWEAVE_VERSION: installedAppVersion ?? "unknown",
      },
    },
  );
  await runChecked(
    commandName("pnpm"),
    [
      "runtime:install",
      "--",
      runtimeZipPath,
      `--runtime-home=${runtimeHome}`,
      ...shellVersionArg,
    ],
    { cwd: sourceRoot },
  );

  const manifest = readJsonFile(runtimeManifestPath);
  if (manifest?.releaseId !== releaseId) {
    throw new Error(
      `runtime manifest identity mismatch: expected ${releaseId}`,
    );
  }
  return manifest;
}

export async function runAppServerUpdate({
  appServerHome,
  controlCliPath,
  sourceRoot,
}) {
  const instanceKey = path.basename(path.resolve(appServerHome));
  const releaseId = `local-app-server-${instanceKey}-${Date.now()}`;
  const cliEntry =
    controlCliPath ??
    path.join(
      sourceRoot,
      "packages",
      "runweave-cli",
      "dist",
      "index.js",
    );

  await runChecked(
    "node",
    [
      "./scripts/install-app-server-runtime.mjs",
      `--release-id=${releaseId}`,
      `--home=${appServerHome}`,
    ],
    { cwd: sourceRoot },
  );
  await fs.access(cliEntry);

  const restart = await runCaptureChecked(
    "node",
    [
      cliEntry,
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

export async function runAppUpdate({
  appBackupPath,
  appBuildVersion,
  appPath,
  channel,
  codesignIdentity,
  gitHead,
  launchAfterInstall,
  sourceRoot,
}) {
  const releaseAppPath = path.join(
    process.env.RUNWEAVE_ELECTRON_BUILD_ROOT ??
      path.join(sourceRoot, "electron"),
    "release",
    "mac-arm64",
    `${appName}.app`,
  );
  await runChecked(
    "node",
    [
      "./scripts/electron-dist-retry.mjs",
      "--config",
      electronBuilderConfig,
      "--mac",
      "--arm64",
    ],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        RUNWEAVE_DESKTOP_CHANNEL: channel,
        RUNWEAVE_DESKTOP_SOURCE_REVISION: gitHead ?? "unknown",
        RUNWEAVE_ELECTRON_BUILD_VERSION: appBuildVersion,
        VITE_RUNWEAVE_CHANNEL: channel,
        VITE_RUNWEAVE_SOURCE_REVISION: gitHead ?? "unknown",
        VITE_RUNWEAVE_VERSION: appBuildVersion,
        ...(codesignIdentity
          ? { RUNWEAVE_CODESIGN_IDENTITY: codesignIdentity }
          : {}),
        RUNWEAVE_SKIP_ELECTRON_VERSION_BUMP: "true",
      },
    },
  );
  await quitApp();
  await installBuiltApp({ appBackupPath, appPath, releaseAppPath });
  if (launchAfterInstall) {
    await openApp(appPath);
  }
}

export async function writeUpdateState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
