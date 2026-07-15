import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { DevSessionError } from "./contracts.mjs";
import {
  buildBetaStatus,
  resolveBetaPaths,
} from "../runweave-beta-state.mjs";
import {
  fetchHealthJson,
  inspectAppServerHandshake,
  inspectBackendHandshake,
  readJson,
  readProcessSignature,
} from "./service-runtime.mjs";

const execFileAsync = promisify(execFile);

export function buildBetaStopArgs({
  sourceRoot,
  instanceId,
  sessionId,
  sharedAppServer,
}) {
  const args = [
    path.join(sourceRoot, "scripts", "runweave-beta.mjs"),
    "stop",
    "--instance",
    instanceId,
    "--dev-session",
    sessionId,
  ];
  if (sharedAppServer) {
    args.push("--shared-app-server-lock-path", sharedAppServer.lockPath);
  }
  return args;
}

export async function startDedicatedBeta({
  sourceRoot,
  sessionId,
  instanceId,
  slotId,
  leaseNonce,
  revision,
  desktopCdpPort,
  terminalBrowserCdpPort,
  sharedBackend,
  sharedAppServer,
  requestedSharedBackend,
  requestedSharedAppServer,
  onSpawn,
}) {
  const paths = resolveBetaPaths(
    sourceRoot,
    os.homedir(),
    instanceId,
    sessionId,
    { desktopCdpPort, terminalBrowserCdpPort },
  );
  const controlArgs = [
    path.join(sourceRoot, "scripts", "runweave-beta.mjs"),
    "update",
    "--instance",
    instanceId,
    "--dev-session",
    sessionId,
    "--desktop-cdp-port",
    String(desktopCdpPort),
    "--terminal-browser-cdp-port",
    String(terminalBrowserCdpPort),
    "--mode",
    "app",
    "--app-server",
    sharedAppServer ? "skip" : "update",
  ];
  if (sharedAppServer) {
    controlArgs.push(
      "--shared-app-server-lock-path",
      sharedAppServer.lockPath,
    );
  }
  const launchEnv = { ...process.env };
  launchEnv.RUNWEAVE_MANAGES_PACKAGED_BACKEND = sharedBackend
    ? "false"
    : "true";
  for (const key of [
    "RUNWEAVE_EXPECTED_BACKEND_ID",
    "RUNWEAVE_SHARED_BACKEND_PID",
    "RUNWEAVE_SHARED_BACKEND_PROFILE_DIR",
  ]) {
    delete launchEnv[key];
  }
  if (!sharedBackend) {
    delete launchEnv.RUNWEAVE_BACKEND_URL;
  }
  for (const key of [
    "RUNWEAVE_APP_SERVER_DISCOVERY",
    "RUNWEAVE_APP_SERVER_TOKEN",
    "RUNWEAVE_APP_SERVER_URL",
    "RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH",
    "RUNWEAVE_SHARED_APP_SERVER_PID",
  ]) {
    delete launchEnv[key];
  }
  if (sharedBackend) {
    Object.assign(launchEnv, {
      RUNWEAVE_MANAGES_PACKAGED_BACKEND: "false",
      RUNWEAVE_BACKEND_URL: sharedBackend.url,
      RUNWEAVE_EXPECTED_BACKEND_ID: sharedBackend.serviceInstanceId,
      RUNWEAVE_SHARED_BACKEND_PID: String(sharedBackend.pid),
      RUNWEAVE_SHARED_BACKEND_PROFILE_DIR: path.dirname(
        sharedBackend.lockPath,
      ),
    });
  }
  if (sharedAppServer) {
    Object.assign(launchEnv, {
      RUNWEAVE_APP_SERVER_DISCOVERY: "explicit",
      RUNWEAVE_APP_SERVER_HOME: path.dirname(sharedAppServer.lockPath),
      RUNWEAVE_APP_SERVER_TOKEN: readFileSync(
        sharedAppServer.tokenPath,
        "utf8",
      ).trim(),
      RUNWEAVE_APP_SERVER_URL: sharedAppServer.url,
      RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH: sharedAppServer.lockPath,
      RUNWEAVE_SHARED_APP_SERVER_PID: String(sharedAppServer.pid),
    });
  }
  const stopBetaControl = async () => {
    await execFileAsync(
      process.execPath,
      buildBetaStopArgs({
        sourceRoot,
        instanceId,
        sessionId,
        sharedAppServer,
      }),
      { cwd: sourceRoot, encoding: "utf8" },
    );
  };
  try {
    await execFileAsync(process.execPath, controlArgs, {
      cwd: sourceRoot,
      encoding: "utf8",
      env: launchEnv,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
  } catch (error) {
    let cleanupFailure = null;
    try {
      await stopBetaControl();
    } catch (stopError) {
      cleanupFailure =
        stopError instanceof Error ? stopError.message : String(stopError);
    }
    throw new DevSessionError("Beta instance update/start failed", 1, {
      instanceId,
      stderr: error?.stderr?.slice(-4_000) ?? null,
      ...(cleanupFailure
        ? { resetUnsafe: true, cleanupFailure }
        : { resetUnsafe: false }),
    });
  }
  const status = await buildBetaStatus(paths);
  if (
    status.instanceId !== instanceId ||
    status.devSessionId !== sessionId ||
    status.source.gitHead !== revision ||
    !status.desktop.healthy ||
    !status.backend.healthy ||
    !status.appServer.healthy ||
    !status.cdp.desktop.healthy ||
    !status.cdp.terminalBrowser.healthy
  ) {
    try {
      await stopBetaControl();
    } catch (error) {
      throw new DevSessionError(
        "Beta readiness failed and identity-safe cleanup did not complete",
        5,
        {
          instanceId,
          status,
          resetUnsafe: true,
          cleanupFailure: error instanceof Error ? error.message : String(error),
        },
      );
    }
    throw new DevSessionError("Beta instance readiness identity failed", 4, {
      instanceId,
      status,
    });
  }
  const processInfo = {
    pid: status.desktop.pid,
    command: `open -n ${paths.appPath}`,
    cwd: sourceRoot,
    startedAt: new Date().toISOString(),
    processSignature: readProcessSignature(status.desktop.pid),
    logPath: status.update.logPath,
  };
  onSpawn(processInfo, stopBetaControl);
  const backendLockPath =
    sharedBackend?.lockPath ?? path.join(paths.profileDir, "backend.lock.json");
  const appServerLockPath =
    sharedAppServer?.lockPath ?? paths.appServerLockPath;
  const [backendLock, backendHealth, appServerLock, appServerHealth] =
    await Promise.all([
      readJson(backendLockPath),
      fetchHealthJson(`${status.backend.baseUrl}/health`),
      readJson(appServerLockPath),
      fetchHealthJson(`${status.appServer.baseUrl}/healthz`),
    ]);
  if (
    !backendLock ||
    backendHealth?.status !== "ok" ||
    !appServerLock ||
    appServerHealth?.ok !== true
  ) {
    await stopBetaControl();
    throw new DevSessionError(
      "Beta component ownership handshake failed",
      4,
      { instanceId },
    );
  }
  const electron = {
    ownership: "dedicated",
    serviceInstanceId: `beta:${instanceId}:${status.desktop.pid}`,
    ownerDevSessionId: sessionId,
    instanceId,
    slotId,
    leaseNonce,
    channel: "beta",
    pid: status.desktop.pid,
    sourceRevision: revision,
    userDataDir: status.desktop.userDataPath,
    statusPath: status.desktop.statusPath,
    desktopCdpEndpoint: status.cdp.desktop.endpoint,
    terminalBrowserCdpEndpoint: status.cdp.terminalBrowser.endpoint,
    frontendUrl: "runweave://app",
    appPath: status.desktop.appPath,
    betaControl: {
      command: process.execPath,
      args: buildBetaStopArgs({
        sourceRoot,
        instanceId,
        sessionId,
        sharedAppServer,
      }),
      cwd: sourceRoot,
    },
    process: processInfo,
  };
  const frontend = {
    ownership: "dedicated",
    serviceInstanceId: `beta-renderer:${instanceId}:${status.desktop.pid}`,
    ownerDevSessionId: sessionId,
    slotId,
    leaseNonce,
    pid: status.desktop.pid,
    url: "runweave://app/index.html",
    sourceRevision: revision,
    expectedBackendServiceInstanceId: backendHealth.serviceInstanceId,
    process: processInfo,
  };
  const sharedBackendWithSlot = sharedBackend
    ? { ...sharedBackend, slotId, leaseNonce }
    : null;
  const backend = sharedBackendWithSlot ?? {
    ownership: "dedicated",
    serviceInstanceId: backendHealth.serviceInstanceId,
    ownerDevSessionId: sessionId,
    slotId,
    leaseNonce,
    pid: backendLock.pid,
    url: status.backend.baseUrl,
    resourceNamespace: backendHealth.resourceNamespace,
    protocolVersion: backendHealth.protocolVersion,
    capabilities: backendHealth.capabilities,
    sourceRevision: revision,
    profileDir: paths.profileDir,
    lockPath: backendLockPath,
    lockStartedAt: backendLock.startedAt,
    lockCwd: backendLock.cwd,
    process: {
      pid: backendLock.pid,
      command: "Runweave Beta packaged backend",
      cwd: backendLock.cwd,
      startedAt: backendLock.startedAt,
      processSignature: readProcessSignature(backendLock.pid),
      logPath: status.update.logPath,
    },
  };
  const sharedAppServerWithSlot = sharedAppServer
    ? { ...sharedAppServer, slotId, leaseNonce }
    : null;
  const appServer = sharedAppServerWithSlot ?? {
    ownership: "dedicated",
    serviceInstanceId: appServerHealth.serviceInstanceId,
    ownerDevSessionId: sessionId,
    slotId,
    leaseNonce,
    pid: appServerLock.pid,
    url: status.appServer.baseUrl,
    protocolVersion: appServerHealth.protocolVersion,
    capabilities: appServerHealth.capabilities,
    sourceRevision: revision,
    homeDir: paths.appServerHome,
    lockPath: appServerLockPath,
    lockStartedAt: appServerLock.startedAt,
    lockIdentity: {
      entry: appServerLock.entry,
      releaseId: appServerLock.releaseId ?? null,
      runtimeRoot: appServerLock.runtimeRoot ?? null,
    },
    tokenPath: path.join(paths.appServerHome, "app-server-token"),
    process: {
      pid: appServerLock.pid,
      command: "Runweave Beta App Server",
      cwd: appServerLock.runtimeRoot ?? paths.appServerHome,
      startedAt: appServerLock.startedAt,
      processSignature: readProcessSignature(appServerLock.pid),
      logPath: paths.appServerLogPath,
    },
  };
  const [backendInspection, appServerInspection] = await Promise.all([
    inspectBackendHandshake(backend),
    inspectAppServerHandshake(appServer),
  ]);
  if (!backendInspection.ok || !appServerInspection.ok) {
    await stopBetaControl();
    throw new DevSessionError("Beta component identity drifted", 4, {
      instanceId,
      backend: backendInspection.reason,
      appServer: appServerInspection.reason,
    });
  }
  if (!sharedBackend && requestedSharedBackend) {
    backend.ownershipUpgradeReason =
      "Default Backend was unavailable; upgraded to dedicated Beta Backend";
  }
  if (!sharedAppServer && requestedSharedAppServer) {
    appServer.ownershipUpgradeReason =
      "Default App Server was unavailable; upgraded to dedicated Beta App Server";
  }
  return {
    frontend,
    backend,
    appServer,
    electron,
    beta: {
      ...electron,
      serviceInstanceId: `beta-control:${instanceId}`,
    },
    cdp: {
      desktop: {
        ownership: "dedicated",
        serviceInstanceId: `cdp:${instanceId}:desktop`,
        ownerDevSessionId: sessionId,
        slotId,
        leaseNonce,
        instanceId,
        pid: status.desktop.pid,
        endpoint: status.cdp.desktop.endpoint,
        sourceRevision: revision,
      },
      terminalBrowser: {
        ownership: "dedicated",
        serviceInstanceId: `cdp:${instanceId}:terminal-browser`,
        ownerDevSessionId: sessionId,
        slotId,
        leaseNonce,
        instanceId,
        pid: status.desktop.pid,
        endpoint: status.cdp.terminalBrowser.endpoint,
        sourceRevision: revision,
      },
    },
  };
}
