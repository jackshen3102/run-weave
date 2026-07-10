import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BETA_UPDATE_APP_NAME,
  resolveBetaUpdateTargets,
} from "./runweave-update-core.mjs";

const BETA_APP_NAME = BETA_UPDATE_APP_NAME;
const BETA_CHANNEL = "beta";
const STATUS_WAIT_MS = 45_000;

class BetaHealthError extends Error {
  constructor(unhealthyComponents) {
    super("Beta did not reach desktop/backend/CDP health before timeout");
    this.name = "BetaHealthError";
    this.unhealthyComponents = unhealthyComponents;
  }
}

function resolveBetaPaths(sourceRoot = process.cwd(), homeDir = os.homedir()) {
  const targets = resolveBetaUpdateTargets(homeDir);
  const userData = targets.userData;
  const updateDir = path.join(userData, "update");
  const appServerHome = targets.appServerHome;
  return {
    sourceRoot: path.resolve(sourceRoot),
    appPath: targets.appPath,
    appBackupPath: path.join("/Applications", `.${BETA_APP_NAME}.app.previous`),
    appServerHome,
    appServerCloudSyncDir: path.join(appServerHome, "cloud-sync"),
    appServerCurrentPath: path.join(appServerHome, "runtime", "current.json"),
    appServerLockPath: path.join(appServerHome, "app-server.lock.json"),
    appServerLogPath: path.join(appServerHome, "app-server.log"),
    appServerEventLogPath: path.join(appServerHome, "app-server-events.jsonl"),
    cliConfigPath: path.join(userData, "cli", "config.json"),
    desktopStatusPath: path.join(userData, "beta-desktop-status.json"),
    logDir: path.join(updateDir, "logs"),
    pendingPath: path.join(updateDir, "pending.json"),
    profileDir: path.join(userData, "browser-profile"),
    runtimeHome: targets.runtimeHome,
    runtimeCurrentPath: path.join(userData, "runtime", "current.json"),
    statePath: targets.statePath,
    userData,
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

async function readReleaseId(pointerPath) {
  const releaseId = (await readJson(pointerPath))?.releaseId;
  return typeof releaseId === "string" && releaseId ? releaseId : null;
}

async function writeReleaseId(pointerPath, releaseId) {
  if (!releaseId) {
    await fs.rm(pointerPath, { force: true });
    return;
  }
  await writeJson(pointerPath, {
    releaseId,
    activatedAt: new Date().toISOString(),
  });
}

function isPidLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runCapture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
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
    child.once("error", reject);
    child.once("close", (code, signal) => {
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

async function getGitHead(sourceRoot) {
  const result = await runCapture("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
  });
  return result.ok ? result.stdout.trim() : null;
}

async function getAppVersion(appPath) {
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
  return result.ok ? result.stdout.trim() || null : null;
}

async function getPathIdentity(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

async function isHttpHealthy(url) {
  if (!url) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isCdpEndpointOwnedByDesktop(endpoint, desktopPid) {
  if (!endpoint || !isPidLive(desktopPid)) {
    return false;
  }
  let port;
  try {
    const parsed = new URL(endpoint);
    if (parsed.hostname !== "127.0.0.1") {
      return false;
    }
    port = Number(parsed.port);
  } catch {
    return false;
  }
  if (!Number.isInteger(port) || port <= 0) {
    return false;
  }
  const result = await runCapture("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  return (
    result.ok &&
    result.stdout
      .split(/\r?\n/)
      .some((value) => Number(value.trim()) === desktopPid)
  );
}

async function hasCdpPageTarget(endpoint) {
  if (!endpoint) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(
      `${String(endpoint).replace(/\/$/, "")}/json/list`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      return false;
    }
    const targets = await response.json();
    return (
      Array.isArray(targets) &&
      targets.some(
        (target) =>
          target?.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string" &&
          target.webSocketDebuggerUrl.length > 0,
      )
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function buildBetaStatus(paths) {
  const [
    state,
    desktopState,
    appServerLock,
    runtimeReleaseId,
    appServerReleaseId,
  ] = await Promise.all([
    readJson(paths.statePath),
    readJson(paths.desktopStatusPath),
    readJson(paths.appServerLockPath),
    readReleaseId(paths.runtimeCurrentPath),
    readReleaseId(paths.appServerCurrentPath),
  ]);
  const desktopPid = desktopState?.app?.pid ?? null;
  const desktopPath = desktopState?.app?.path ?? paths.appPath;
  const desktopLive =
    desktopState?.channel === BETA_CHANNEL &&
    desktopPath === paths.appPath &&
    isPidLive(desktopPid);
  const backendPid = desktopState?.backend?.pid ?? null;
  const backendLive =
    desktopLive &&
    desktopState?.backend?.available === true &&
    isPidLive(backendPid);
  const appServerPid = appServerLock?.pid ?? null;
  const appServerBaseUrl =
    appServerLock?.host === "127.0.0.1" && Number.isInteger(appServerLock?.port)
      ? `http://127.0.0.1:${appServerLock.port}`
      : null;
  const cdpEndpoint = desktopState?.cdp?.endpoint ?? null;
  const [appServerHealthy, cdpHealthy] = await Promise.all([
    isPidLive(appServerPid)
      ? isHttpHealthy(appServerBaseUrl ? `${appServerBaseUrl}/healthz` : null)
      : false,
    desktopLive && cdpEndpoint
      ? Promise.all([
          isCdpEndpointOwnedByDesktop(cdpEndpoint, desktopPid),
          hasCdpPageTarget(cdpEndpoint),
        ]).then((checks) => checks.every(Boolean))
      : false,
  ]);

  return {
    schemaVersion: 1,
    channel: BETA_CHANNEL,
    source: {
      root: state?.sourceRoot ?? paths.sourceRoot,
      gitHead: state?.gitHead ?? null,
      dirty: state?.gitDirty ?? null,
      deployedAt: state?.updatedAt ?? null,
    },
    desktop: {
      appPath: paths.appPath,
      healthy: desktopLive,
      pid: desktopLive ? desktopPid : null,
      sourceRevision: state?.gitHead ?? desktopState?.sourceRevision ?? null,
      statusPath: paths.desktopStatusPath,
      userDataPath: paths.userData,
      version: desktopState?.app?.version ?? state?.appVersion ?? null,
    },
    backend: {
      baseUrl: backendLive ? desktopState.backend.baseUrl : null,
      healthy: backendLive,
      pid: backendLive ? backendPid : null,
      profileDir: paths.profileDir,
      cliConfigPath: paths.cliConfigPath,
      profileLockPath: path.join(paths.profileDir, "backend.lock.json"),
      runtimeHome: paths.runtimeHome,
      runtimeReleaseId:
        runtimeReleaseId ?? desktopState?.backend?.runtimeReleaseId ?? null,
    },
    appServer: {
      baseUrl: appServerHealthy ? appServerBaseUrl : null,
      cloudSyncDir: paths.appServerCloudSyncDir,
      eventLogPath: paths.appServerEventLogPath,
      healthy: appServerHealthy,
      home: paths.appServerHome,
      lockPath: paths.appServerLockPath,
      logPath: paths.appServerLogPath,
      pid: appServerHealthy ? appServerPid : null,
      releaseId: appServerReleaseId ?? appServerLock?.releaseId ?? null,
      runtimeRoot: path.join(paths.appServerHome, "runtime"),
    },
    cdp: {
      endpoint: cdpHealthy ? cdpEndpoint : null,
      healthy: cdpHealthy,
    },
    previous: state?.previous ?? null,
    lastFailure: state?.lastFailure ?? null,
    update: {
      lastAction: state?.mode ?? null,
      lastAppServerAction: state?.appServerAction ?? null,
      logPath: state?.logPath ?? null,
      statePath: paths.statePath,
    },
  };
}

async function collectBaseline(paths) {
  const state = await readJson(paths.statePath);
  return {
    capturedAt: new Date().toISOString(),
    app: {
      backupPath: null,
      exists: existsSync(paths.appPath),
      identity: await getPathIdentity(paths.appPath),
      version: await getAppVersion(paths.appPath),
    },
    appServerReleaseId: await readReleaseId(paths.appServerCurrentPath),
    desktopStatusUpdatedAt:
      (await readJson(paths.desktopStatusPath))?.updatedAt ?? null,
    runtimeReleaseId: await readReleaseId(paths.runtimeCurrentPath),
    priorAppBackupPath: state?.previous?.app?.backupPath ?? null,
    source: {
      gitDirty: state?.gitDirty ?? null,
      gitHead: state?.gitHead ?? null,
      sourceRoot: state?.sourceRoot ?? paths.sourceRoot,
      updatedAt: state?.updatedAt ?? null,
      worktreeSnapshot: state?.worktreeSnapshot ?? null,
    },
  };
}

function buildUpdateEnv(paths, gitHead, appBackupPath = paths.appBackupPath) {
  return {
    ...process.env,
    BROWSER_PROFILE_DIR: paths.profileDir,
    RUNWEAVE_CONFIG_FILE: paths.cliConfigPath,
    RUNWEAVE_APP_BACKUP_PATH: appBackupPath,
    RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR: paths.appServerCloudSyncDir,
    RUNWEAVE_APP_SERVER_HOME: paths.appServerHome,
    RUNWEAVE_DESKTOP_CHANNEL: BETA_CHANNEL,
    RUNWEAVE_DESKTOP_SOURCE_REVISION: gitHead ?? "unknown",
    RUNWEAVE_ELECTRON_BUILDER_CONFIG: "electron-builder.beta.yml",
    RUNWEAVE_LOCAL_UPDATE_APP_NAME: BETA_APP_NAME,
    RUNWEAVE_UPDATE_TARGET: BETA_CHANNEL,
    VITE_RUNWEAVE_CHANNEL: BETA_CHANNEL,
    VITE_RUNWEAVE_SOURCE_REVISION: gitHead ?? "unknown",
  };
}

function buildUpdateArgs(paths, args) {
  return [
    path.join(paths.sourceRoot, "scripts", "runweave-update.mjs"),
    "--repo",
    paths.sourceRoot,
    "--app-path",
    paths.appPath,
    "--runtime-home",
    paths.runtimeHome,
    "--app-server-home",
    paths.appServerHome,
    "--state-path",
    paths.statePath,
    ...args,
  ];
}

async function runUpdateProcess(paths, args, env, logPath) {
  let logHandle = null;
  if (logPath) {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    logHandle = await fs.open(logPath, "a", 0o600);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn("node", buildUpdateArgs(paths, args), {
      cwd: paths.sourceRoot,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const write = (stream, chunk) => {
      stream.write(chunk);
      if (logHandle) {
        void logHandle.write(chunk);
      }
    };
    child.stdout.on("data", (chunk) => write(process.stdout, chunk));
    child.stderr.on("data", (chunk) => write(process.stderr, chunk));
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      await logHandle?.close();
      resolve({ ok: code === 0, code: code ?? 1, signal });
    });
  });
}

async function quitBeta(paths) {
  const desktopState = await readJson(paths.desktopStatusPath);
  const pid = desktopState?.app?.pid;
  if (!isPidLive(pid)) {
    return;
  }
  await runCapture("osascript", [
    "-e",
    `tell application "${BETA_APP_NAME}" to quit`,
  ]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && isPidLive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (isPidLive(pid)) {
    process.kill(pid, "SIGTERM");
  }
}

async function openBeta(paths) {
  if (!existsSync(paths.appPath)) {
    return;
  }
  const result = await runCapture("open", ["-n", paths.appPath]);
  if (!result.ok) {
    throw new Error(`failed to open ${paths.appPath}: ${result.stderr}`);
  }
}

async function runAppServerCli(paths, command) {
  const cliEntry = path.join(
    paths.sourceRoot,
    "packages",
    "runweave-cli",
    "dist",
    "index.js",
  );
  if (!existsSync(cliEntry)) {
    return { ok: false, code: 1, stderr: `missing CLI build: ${cliEntry}` };
  }
  return await runCapture(
    "node",
    [cliEntry, "app-server", command, "--home", paths.appServerHome],
    { env: buildUpdateEnv(paths, await getGitHead(paths.sourceRoot)) },
  );
}

async function restoreBaseline(paths, baseline, options = {}) {
  const currentAppIdentity = await getPathIdentity(paths.appPath);
  const currentRuntimeReleaseId = await readReleaseId(paths.runtimeCurrentPath);
  const currentAppServerReleaseId = await readReleaseId(
    paths.appServerCurrentPath,
  );
  const appChanged =
    options.forceApp === true || currentAppIdentity !== baseline.app.identity;
  const runtimeChanged = currentRuntimeReleaseId !== baseline.runtimeReleaseId;
  const appServerChanged =
    currentAppServerReleaseId !== baseline.appServerReleaseId;

  if (appChanged || runtimeChanged) {
    await quitBeta(paths);
  }
  if (appServerChanged) {
    await runAppServerCli(paths, "stop");
  }
  if (runtimeChanged) {
    await writeReleaseId(paths.runtimeCurrentPath, baseline.runtimeReleaseId);
  }
  if (appServerChanged) {
    await writeReleaseId(
      paths.appServerCurrentPath,
      baseline.appServerReleaseId,
    );
    if (baseline.appServerReleaseId) {
      const restart = await runAppServerCli(paths, "restart");
      if (!restart.ok) {
        throw new Error(`failed to restore Beta App Server: ${restart.stderr}`);
      }
    }
  }
  if (appChanged) {
    const appBackupPath = baseline.app.backupPath ?? paths.appBackupPath;
    if (baseline.app.exists && existsSync(appBackupPath)) {
      const failedPath = `${paths.appPath}.failed-${Date.now()}`;
      if (existsSync(paths.appPath)) {
        await fs.rename(paths.appPath, failedPath);
      }
      await fs.rename(appBackupPath, paths.appPath);
      await fs.rm(failedPath, { force: true, recursive: true });
    } else if (!baseline.app.exists) {
      await fs.rm(paths.appPath, { force: true, recursive: true });
    }
  }
  if (
    (appChanged || runtimeChanged || appServerChanged) &&
    baseline.app.exists
  ) {
    await openBeta(paths);
  }

  return { appChanged, appServerChanged, runtimeChanged };
}

async function waitForHealthyBeta(paths, requireAppServer, startedAt) {
  const deadline = Date.now() + STATUS_WAIT_MS;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const status = await buildBetaStatus(paths);
    lastStatus = status;
    const statusUpdatedAt = await readJson(paths.desktopStatusPath).then(
      (value) => value?.updatedAt ?? null,
    );
    const fresh =
      typeof statusUpdatedAt === "string" &&
      Date.parse(statusUpdatedAt) >= startedAt;
    if (
      fresh &&
      status.desktop.healthy &&
      status.backend.healthy &&
      status.cdp.healthy &&
      (!requireAppServer || status.appServer.healthy)
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const unhealthyComponents = [
    ["desktop", lastStatus?.desktop?.healthy],
    ["backend", lastStatus?.backend?.healthy],
    ["cdp", lastStatus?.cdp?.healthy],
    ...(requireAppServer
      ? [["app-server", lastStatus?.appServer?.healthy]]
      : []),
  ]
    .filter(([, healthy]) => healthy !== true)
    .map(([component]) => component);
  throw new BetaHealthError(unhealthyComponents);
}

function formatBetaUpdateFailure({
  baseline,
  cause,
  logPath,
  recovery,
  unhealthyComponents,
}) {
  return [
    "Beta update failed",
    "component=beta-update",
    `unhealthyComponents=${unhealthyComponents.join(",") || "unknown"}`,
    `logPath=${logPath}`,
    `previousRelease=${JSON.stringify({
      appVersion: baseline.app?.version ?? null,
      runtimeReleaseId: baseline.runtimeReleaseId ?? null,
      appServerReleaseId: baseline.appServerReleaseId ?? null,
    })}`,
    `recovery=${recovery}`,
    `reason=${cause instanceof Error ? cause.message : String(cause)}`,
  ].join("; ");
}

async function appendFailureDiagnostic(logPath, diagnostic) {
  await fs.appendFile(logPath, `[runweave-beta] ${diagnostic}\n`, {
    mode: 0o600,
  });
}

async function recordFailure(paths, baseline, logPath, summary) {
  const state = (await readJson(paths.statePath)) ?? {};
  await writeJson(paths.statePath, {
    ...state,
    appServer: baseline.appServerReleaseId
      ? {
          ...(state.appServer ?? {}),
          home: paths.appServerHome,
          releaseId: baseline.appServerReleaseId,
        }
      : null,
    appServerAction: baseline.appServerReleaseId ? "restored" : null,
    appServerReleaseId: baseline.appServerReleaseId,
    appVersion: baseline.app.version,
    channel: BETA_CHANNEL,
    gitDirty: baseline.source?.gitDirty ?? null,
    gitHead: baseline.source?.gitHead ?? null,
    previous: baseline,
    runtimeReleaseId: baseline.runtimeReleaseId,
    sourceRoot: baseline.source?.sourceRoot ?? paths.sourceRoot,
    worktreeSnapshot: baseline.source?.worktreeSnapshot ?? null,
    lastFailure: {
      at: new Date().toISOString(),
      attemptedGitHead: state.gitHead ?? null,
      component: "beta-update",
      logPath,
      summary,
    },
  });
}

async function update(paths, args) {
  const dryRun = args.includes("--dry-run");
  const gitHead = await getGitHead(paths.sourceRoot);
  const env = buildUpdateEnv(paths, gitHead);
  if (dryRun) {
    const result = await runUpdateProcess(paths, args, env, null);
    if (!result.ok) {
      process.exitCode = result.code;
    }
    return;
  }

  const startedAt = Date.now();
  const baseline = await collectBaseline(paths);
  baseline.app.backupPath = path.join(
    "/Applications",
    `.${BETA_APP_NAME}.app.previous-${startedAt}`,
  );
  const logPath = path.join(
    paths.logDir,
    `update-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
  );
  await writeJson(paths.pendingPath, { baseline, gitHead, logPath, startedAt });

  const result = await runUpdateProcess(
    paths,
    args,
    buildUpdateEnv(paths, gitHead, baseline.app.backupPath),
    logPath,
  );
  if (!result.ok) {
    const cause = new Error(`update process exited with code ${result.code}`);
    let recovery = "automatic-restore-failed";
    try {
      await restoreBaseline(paths, baseline);
      recovery = "automatic-restore-applied";
    } finally {
      const diagnostic = formatBetaUpdateFailure({
        baseline,
        cause,
        logPath,
        recovery,
        unhealthyComponents: ["update-process"],
      });
      console.error(diagnostic);
      await appendFailureDiagnostic(logPath, diagnostic);
      await recordFailure(paths, baseline, logPath, cause.message);
      await fs.rm(paths.pendingPath, { force: true });
    }
    process.exitCode = result.code;
    return;
  }

  const state = (await readJson(paths.statePath)) ?? {};
  await writeJson(paths.statePath, {
    ...state,
    channel: BETA_CHANNEL,
    previous: baseline,
    logPath,
    lastFailure: null,
  });
  if (
    state.mode === "app" &&
    baseline.priorAppBackupPath &&
    baseline.priorAppBackupPath !== baseline.app.backupPath
  ) {
    await fs.rm(baseline.priorAppBackupPath, { force: true, recursive: true });
  }
  await fs.rm(paths.pendingPath, { force: true });

  try {
    const status = await waitForHealthyBeta(
      paths,
      state.appServerAction === "update",
      startedAt,
    );
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    let recovery = "automatic-restore-failed";
    try {
      await restoreBaseline(paths, baseline);
      recovery = "automatic-restore-applied";
    } finally {
      const diagnostic = formatBetaUpdateFailure({
        baseline,
        cause: error,
        logPath,
        recovery,
        unhealthyComponents:
          error instanceof BetaHealthError
            ? error.unhealthyComponents
            : ["beta-update"],
      });
      console.error(diagnostic);
      await appendFailureDiagnostic(logPath, diagnostic);
      await recordFailure(
        paths,
        baseline,
        logPath,
        error instanceof Error ? error.message : String(error),
      );
    }
    process.exitCode = 1;
  }
}

async function rollback(paths) {
  const state = await readJson(paths.statePath);
  const baseline = state?.previous;
  if (!baseline?.app || !("runtimeReleaseId" in baseline)) {
    throw new Error("No previous Beta release is available for rollback");
  }
  const restored = await restoreBaseline(paths, baseline, {
    forceApp: state.mode === "app",
  });
  await writeJson(paths.statePath, {
    ...state,
    appServerReleaseId: baseline.appServerReleaseId,
    appVersion: baseline.app.version,
    gitDirty: baseline.source?.gitDirty ?? null,
    gitHead: baseline.source?.gitHead ?? null,
    lastFailure: null,
    mode: "rollback",
    runtimeReleaseId: baseline.runtimeReleaseId,
    sourceRoot: baseline.source?.sourceRoot ?? paths.sourceRoot,
    updatedAt: new Date().toISOString(),
    worktreeSnapshot: baseline.source?.worktreeSnapshot ?? null,
    rolledBackAt: new Date().toISOString(),
    rollback: restored,
  });
  const status = await waitForHealthyBeta(
    paths,
    Boolean(baseline.appServerReleaseId),
    Date.now() - 1_000,
  );
  console.log(JSON.stringify(status, null, 2));
}

async function verify(paths) {
  const stablePaths = [
    "/Applications/Runweave.app",
    path.join(os.homedir(), ".runweave", "app-server"),
    path.join(os.homedir(), ".runweave", "config.json"),
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "RunweaveLocalUpdate",
      "state.json",
    ),
  ];
  const betaPaths = [
    paths.appPath,
    paths.appServerHome,
    paths.cliConfigPath,
    paths.statePath,
    paths.runtimeHome,
    paths.profileDir,
  ];
  if (betaPaths.some((entry) => stablePaths.includes(entry))) {
    throw new Error("Beta configuration overlaps a Stable writable path");
  }
  const builderConfig = await fs.readFile(
    path.join(paths.sourceRoot, "electron", "electron-builder.beta.yml"),
    "utf8",
  );
  for (const marker of [
    "com.runweave.desktop.beta",
    "productName: Runweave Beta",
  ]) {
    if (!builderConfig.includes(marker)) {
      throw new Error(`Beta builder config is missing ${marker}`);
    }
  }
  const status = await buildBetaStatus(paths);
  const serialized = JSON.stringify(status);
  if (/authorization|cookie|jwt|password|token/i.test(serialized)) {
    throw new Error("Beta status contains a sensitive field name");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        channel: BETA_CHANNEL,
        isolatedPaths: betaPaths,
        statusContract: status,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const paths = resolveBetaPaths();
  if (command === "update") {
    await update(paths, args);
    return;
  }
  if (command === "status") {
    const json = args.includes("--json");
    const status = await buildBetaStatus(paths);
    if (json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    } else {
      console.log(JSON.stringify(status, null, 2));
    }
    return;
  }
  if (command === "rollback") {
    await rollback(paths);
    return;
  }
  if (command === "verify") {
    await verify(paths);
    return;
  }
  throw new Error(
    "Usage: node scripts/runweave-beta.mjs <update|status|rollback|verify>",
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
