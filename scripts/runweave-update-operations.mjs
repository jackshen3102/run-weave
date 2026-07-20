import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
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

const DESKTOP_VERIFICATION_PORT_START = 9223;
const DESKTOP_VERIFICATION_PORT_ATTEMPTS = 50;

function createDesktopLaunchEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toLowerCase().startsWith("npm_")) {
      delete env[name];
    }
  }
  return env;
}

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

async function isLoopbackPortAvailable(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function resolveDesktopVerificationPort() {
  for (
    let offset = 0;
    offset < DESKTOP_VERIFICATION_PORT_ATTEMPTS;
    offset += 1
  ) {
    const port = DESKTOP_VERIFICATION_PORT_START + offset;
    if (await isLoopbackPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `No desktop verification port is available from ${DESKTOP_VERIFICATION_PORT_START}`,
  );
}

function createDesktopVerificationLaunchEnv({
  appServerHome,
  port,
  runtimeHome,
  statusPath,
}) {
  const env = createDesktopLaunchEnv();
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("RUNWEAVE_") ||
      name.startsWith("BROWSER_VIEWER_") ||
      name === "ELECTRON_RUN_AS_NODE" ||
      name === "FRONTEND_DIST_DIR"
    ) {
      delete env[name];
    }
  }
  env.RUNWEAVE_APP_SERVER_HOME = appServerHome;
  env.RUNWEAVE_DESKTOP_CDP_PORT = String(port);
  env.RUNWEAVE_DESKTOP_STATUS_PATH = statusPath;
  env.RUNWEAVE_RUNTIME_HOME = runtimeHome;
  return env;
}

export function resolveDesktopVerificationResult({
  appPath,
  endpoint,
  expectedAppVersion,
  status,
  statusPath,
  targets,
}) {
  if (
    status?.app?.path !== appPath ||
    status.app.version !== expectedAppVersion ||
    !Number.isInteger(status.app.pid) ||
    status.app.pid <= 0 ||
    status.cdp?.desktop?.endpoint !== endpoint ||
    status.cdp.desktop.pid !== status.app.pid ||
    status.backend?.available !== true ||
    status.window?.visible !== true
  ) {
    return null;
  }

  const page = Array.isArray(targets)
    ? targets.find(
        (target) =>
          target?.type === "page" &&
          (target.url?.startsWith("runweave://app") ||
            target.url?.startsWith("browser-viewer://app")),
      )
    : null;
  if (!page) {
    return null;
  }

  return {
    appServer: status.appServer,
    appPath: status.app.path,
    appVersion: status.app.version,
    backend: status.backend,
    endpoint,
    pageUrl: page.url,
    pid: status.app.pid,
    sourceRevision: status.sourceRevision,
    statusPath,
    window: status.window,
  };
}

async function waitForDesktopVerification({
  appPath,
  endpoint,
  expectedAppVersion,
  statusPath,
}) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const status = readJsonFile(statusPath);
    if (status) {
      try {
        const response = await fetch(`${endpoint}/json/list`);
        const targets = response.ok ? await response.json() : null;
        const result = resolveDesktopVerificationResult({
          appPath,
          endpoint,
          expectedAppVersion,
          status,
          statusPath,
          targets,
        });
        if (result) {
          return result;
        }
      } catch {
        // The renderer and CDP endpoint can become ready after the process starts.
      }
    }
    await wait(500);
  }
  throw new Error(
    `Desktop verification did not become ready at ${statusPath}`,
  );
}

export async function quitApp() {
  if (process.platform !== "darwin") {
    return;
  }

  await run("osascript", ["-e", `tell application "${appName}" to quit`]);
  await waitForAppExit();
}

export async function openApp(appPath, options = {}) {
  if (process.platform !== "darwin") {
    return;
  }

  await fs.access(appPath);
  const desktopVerification = options.desktopVerification ?? null;
  if (desktopVerification) {
    const port = await resolveDesktopVerificationPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const statusPath = path.resolve(desktopVerification.statusPath);
    const executable = path.join(appPath, "Contents", "MacOS", appName);
    await fs.access(executable);
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.rm(statusPath, { force: true });
    const child = spawn(executable, [], {
      detached: true,
      env: createDesktopVerificationLaunchEnv({
        appServerHome: desktopVerification.appServerHome,
        port,
        runtimeHome: desktopVerification.runtimeHome,
        statusPath,
      }),
      stdio: "ignore",
    });
    child.unref();
    await waitForInstalledAppStart(appPath);
    return await waitForDesktopVerification({
      appPath,
      endpoint,
      expectedAppVersion: desktopVerification.expectedAppVersion,
      statusPath,
    });
  }
  if (
    process.env.RUNWEAVE_MANAGES_PACKAGED_BACKEND === "false" ||
    process.env.RUNWEAVE_APP_SERVER_DISCOVERY === "explicit"
  ) {
    const executable = path.join(appPath, "Contents", "MacOS", appName);
    await fs.access(executable);
    const child = spawn(executable, [], {
      detached: true,
      env: createDesktopLaunchEnv(),
      stdio: "ignore",
    });
    child.unref();
  } else {
    await runChecked("open", ["-n", appPath], {
      env: createDesktopLaunchEnv(),
    });
  }
  await waitForInstalledAppStart(appPath);
  return null;
}

export async function restartApp(appPath, options = {}) {
  if (process.platform !== "darwin") {
    return;
  }

  await quitApp();
  return await openApp(appPath, options);
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
  desktopVerification,
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
    return await openApp(appPath, { desktopVerification });
  }
  return null;
}

export async function writeUpdateState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
