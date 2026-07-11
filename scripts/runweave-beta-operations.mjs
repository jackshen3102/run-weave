import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BETA_CHANNEL,
  STATUS_WAIT_MS,
  BetaHealthError,
  buildBetaStatus,
  getAppVersion,
  getGitHead,
  getPathIdentity,
  inspectBetaDesktopProcessOwnership,
  isPidLive,
  readJson,
  readReleaseId,
  readProcessSignature,
  runCapture,
  writeJson,
  writeReleaseId,
} from "./runweave-beta-state.mjs";

export async function collectBaseline(paths) {
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

export function buildUpdateEnv(
  paths,
  gitHead,
  appBackupPath = paths.appBackupPath,
) {
  return {
    ...process.env,
    BROWSER_PROFILE_DIR: paths.profileDir,
    RUNWEAVE_CONFIG_FILE: paths.cliConfigPath,
    RUNWEAVE_CLI_BUNDLE_OUTFILE: paths.controlCliPath,
    RUNWEAVE_APP_BACKUP_PATH: appBackupPath,
    RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR: paths.appServerCloudSyncDir,
    RUNWEAVE_APP_SERVER_HOME: paths.appServerHome,
    RUNWEAVE_DESKTOP_CHANNEL: BETA_CHANNEL,
    RUNWEAVE_DESKTOP_INSTANCE_ID: paths.instanceId,
    RUNWEAVE_DESKTOP_CDP_PORT: String(paths.desktopCdpPort),
    RUNWEAVE_DESKTOP_STATUS_PATH: paths.desktopStatusPath,
    RUNWEAVE_DESKTOP_USER_DATA_DIR: paths.userData,
    RUNWEAVE_TERMINAL_BROWSER_CDP_PROXY_PORT: String(
      paths.terminalBrowserCdpPort,
    ),
    ...(paths.devSessionId
      ? { RUNWEAVE_DEV_SESSION_ID: paths.devSessionId }
      : {}),
    RUNWEAVE_ELECTRON_APP_ID: paths.bundleId,
    RUNWEAVE_ELECTRON_BUILD_ROOT: paths.buildRoot,
    RUNWEAVE_DESKTOP_SOURCE_REVISION: gitHead ?? "unknown",
    RUNWEAVE_SOURCE_REVISION: gitHead ?? "unknown",
    RUNWEAVE_ELECTRON_BUILDER_CONFIG: "electron-builder.beta.yml",
    RUNWEAVE_LOCAL_UPDATE_APP_NAME: paths.appName,
    RUNWEAVE_RUNTIME_ARTIFACTS_ROOT: paths.runtimeArtifactsRoot,
    RUNWEAVE_RUNTIME_BUILD_ROOT: paths.runtimeBuildRoot,
    RUNWEAVE_UPDATE_TARGET: BETA_CHANNEL,
    VITE_RUNWEAVE_CHANNEL: BETA_CHANNEL,
    VITE_RUNWEAVE_SOURCE_REVISION: gitHead ?? "unknown",
  };
}

export function buildUpdateArgs(paths, args) {
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

export async function runUpdateProcess(paths, args, env, logPath) {
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

export async function quitBeta(paths) {
  const ownership = await inspectBetaDesktopProcessOwnership(paths);
  if (!ownership.running) {
    return;
  }
  if (!ownership.ok) {
    throw new Error(`refusing to stop Beta: ${ownership.reason}`);
  }
  const { executable, pid, processSignature } = ownership;
  await runCapture("osascript", [
    "-e",
    `tell application "${paths.appName}" to quit`,
  ]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && isPidLive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (isPidLive(pid)) {
    const currentSignature = await readProcessSignature(pid);
    if (
      currentSignature !== processSignature ||
      !currentSignature.includes(executable)
    ) {
      throw new Error(
        "refusing to signal Beta after quit timeout: process identity drifted",
      );
    }
    process.kill(pid, "SIGTERM");
  }
}

export async function openBeta(paths, explicitEnv = null) {
  if (!existsSync(paths.appPath)) {
    return;
  }
  const state = await readJson(paths.statePath);
  const launchEnv =
    explicitEnv ??
    buildUpdateEnv(
      paths,
      state?.gitHead ?? (await getGitHead(paths.sourceRoot)),
    );
  const executable = path.join(
    paths.appPath,
    "Contents",
    "MacOS",
    paths.appName,
  );
  const child = spawn(executable, [], {
    detached: true,
    env: launchEnv,
    stdio: "ignore",
  });
  child.unref();
}

export async function runAppServerCli(paths, command, sourceRevision = null) {
  const cliEntry = paths.controlCliPath;
  if (!existsSync(cliEntry)) {
    return { ok: false, code: 1, stderr: `missing CLI build: ${cliEntry}` };
  }
  return await runCapture(
    "node",
    [cliEntry, "app-server", command, "--home", paths.appServerHome],
    {
      env: buildUpdateEnv(
        paths,
        sourceRevision ?? (await getGitHead(paths.sourceRoot)),
      ),
    },
  );
}

export async function restoreBaseline(paths, baseline, options = {}) {
  const baselineRevision =
    baseline.source?.gitHead ?? (await getGitHead(paths.sourceRoot));
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
      const restart = await runAppServerCli(paths, "restart", baselineRevision);
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
    await openBeta(paths, buildUpdateEnv(paths, baselineRevision));
  }

  return { appChanged, appServerChanged, runtimeChanged };
}

export async function waitForHealthyBeta(paths, requireAppServer, startedAt) {
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

export function formatBetaUpdateFailure({
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

export async function appendFailureDiagnostic(logPath, diagnostic) {
  await fs.appendFile(logPath, `[runweave-beta] ${diagnostic}\n`, {
    mode: 0o600,
  });
}

export async function recordFailure(paths, baseline, logPath, summary) {
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
