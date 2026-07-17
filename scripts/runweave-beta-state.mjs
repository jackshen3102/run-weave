import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BETA_UPDATE_APP_NAME,
  resolveBetaAppBackupPrefix,
  resolveBetaUpdateTargets,
} from "./runweave-update-core.mjs";
import { isPidLive, runCapture } from "./runweave-beta-process-state.mjs";

export {
  inspectProcessReferences,
  inspectRecordedProcessState,
  isPidLive,
  runCapture,
} from "./runweave-beta-process-state.mjs";

export const BETA_APP_NAME = BETA_UPDATE_APP_NAME;
export const BETA_CHANNEL = "beta";
export const STATUS_WAIT_MS = 45_000;

export class BetaHealthError extends Error {
  constructor(unhealthyComponents) {
    super("Beta did not reach desktop/backend/CDP health before timeout");
    this.name = "BetaHealthError";
    this.unhealthyComponents = unhealthyComponents;
  }
}

export function resolveBetaPaths(
  sourceRoot = process.cwd(),
  homeDir = os.homedir(),
  instanceId = "default",
  devSessionId = null,
  ports = {},
) {
  const targets = resolveBetaUpdateTargets(homeDir, instanceId);
  const userData = targets.userData;
  const updateDir = targets.poolSlot
    ? path.join(targets.instanceRoot, "diagnostics")
    : path.join(userData, "update");
  const appServerHome = targets.appServerHome;
  return {
    sourceRoot: path.resolve(sourceRoot),
    appName: targets.appName,
    appPath: targets.appPath,
    appBackupPath: resolveBetaAppBackupPrefix(targets.instanceId),
    bundleId: targets.bundleId,
    buildRoot: path.join(targets.instanceRoot, "build"),
    devSessionId,
    desktopCdpPort: ports.desktopCdpPort ?? 9335,
    instanceId: targets.instanceId,
    slotId: targets.poolSlot ? targets.instanceId : null,
    poolPolicy: targets.poolSlot ? "fixed-pool-v1" : null,
    instanceRoot: targets.instanceRoot,
    terminalBrowserCdpPort: ports.terminalBrowserCdpPort ?? 9336,
    appServerHome,
    appServerCloudSyncDir: path.join(appServerHome, "cloud-sync"),
    appServerCurrentPath: path.join(appServerHome, "runtime", "current.json"),
    appServerLockPath: path.join(appServerHome, "app-server.lock.json"),
    appServerLogPath: path.join(appServerHome, "app-server.log"),
    appServerEventLogPath: path.join(appServerHome, "app-server-events.jsonl"),
    cliConfigPath: path.join(userData, "cli", "config.json"),
    controlCliPath: path.join(
      targets.instanceRoot,
      "control",
      "cli",
      "index.js",
    ),
    desktopStatusPath: path.join(userData, "beta-desktop-status.json"),
    logDir: path.join(updateDir, "logs"),
    pendingPath: path.join(updateDir, "pending.json"),
    profileDir: path.join(userData, "browser-profile"),
    runtimeHome: targets.runtimeHome,
    runtimeArtifactsRoot: path.join(targets.instanceRoot, "runtime-artifacts"),
    runtimeBuildRoot: path.join(targets.instanceRoot, "build", "runtime"),
    runtimeCurrentPath: path.join(targets.runtimeHome, "current.json"),
    statePath: targets.statePath,
    userData,
    warmStateRoot: targets.warmStateRoot,
  };
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

export async function readReleaseId(pointerPath) {
  const releaseId = (await readJson(pointerPath))?.releaseId;
  return typeof releaseId === "string" && releaseId ? releaseId : null;
}

export async function writeReleaseId(pointerPath, releaseId) {
  if (!releaseId) {
    await fs.rm(pointerPath, { force: true });
    return;
  }
  await writeJson(pointerPath, {
    releaseId,
    activatedAt: new Date().toISOString(),
  });
}

export async function getGitHead(sourceRoot) {
  const result = await runCapture("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
  });
  return result.ok ? result.stdout.trim() : null;
}

export async function getAppVersion(appPath) {
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

export async function getPathIdentity(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

export async function isHttpHealthy(url) {
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

export async function isCdpEndpointOwnedByDesktop(endpoint, desktopPid) {
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

export async function hasCdpPageTarget(endpoint, expectedUrlPrefix = null) {
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
          target.webSocketDebuggerUrl.length > 0 &&
          (!expectedUrlPrefix || target?.url?.startsWith(expectedUrlPrefix)),
      )
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function readProcessSignature(pid) {
  if (!isPidLive(pid)) {
    return "";
  }
  const result = await runCapture("/bin/ps", [
    "-p",
    String(pid),
    "-o",
    "lstart=",
    "-o",
    "command=",
  ]);
  return result.ok ? result.stdout.trim() : "";
}

export async function inspectBetaDesktopProcessOwnership(paths) {
  const desktopState = await readJson(paths.desktopStatusPath);
  const pid = desktopState?.app?.pid;
  if (!isPidLive(pid)) {
    return {
      ok: false,
      running: false,
      reason: "Beta desktop is not running",
      desktopState,
    };
  }
  const executable = desktopState?.app?.executable;
  const expectedExecutableRoot = path.join(paths.appPath, "Contents", "MacOS");
  const currentProcessSignature = await readProcessSignature(pid);
  if (
    desktopState?.channel !== BETA_CHANNEL ||
    desktopState?.instanceId !== paths.instanceId ||
    (paths.devSessionId && desktopState?.devSessionId !== paths.devSessionId) ||
    desktopState?.app?.path !== paths.appPath ||
    desktopState?.app?.userDataPath !== paths.userData ||
    typeof desktopState?.app?.startedAt !== "string" ||
    typeof executable !== "string" ||
    !path
      .resolve(executable)
      .startsWith(`${expectedExecutableRoot}${path.sep}`) ||
    !desktopState?.app?.processSignature ||
    currentProcessSignature !== desktopState.app.processSignature ||
    !currentProcessSignature.includes(executable)
  ) {
    return {
      ok: false,
      running: true,
      reason: "Beta desktop process identity drifted",
      desktopState,
    };
  }
  return {
    ok: true,
    running: true,
    reason: null,
    desktopState,
    executable,
    pid,
    processSignature: currentProcessSignature,
  };
}

export async function inspectBetaDesktopOwnership(paths) {
  const processOwnership = await inspectBetaDesktopProcessOwnership(paths);
  if (!processOwnership.ok) {
    return processOwnership;
  }
  const { desktopState, pid } = processOwnership;
  const desktopEndpoint = desktopState?.cdp?.desktop?.endpoint;
  const terminalBrowserEndpoint = desktopState?.cdp?.terminalBrowser?.endpoint;
  const [desktopOwned, desktopTarget, terminalOwned, terminalVersion] =
    await Promise.all([
      isCdpEndpointOwnedByDesktop(desktopEndpoint, pid),
      hasCdpPageTarget(desktopEndpoint, "runweave://app"),
      isCdpEndpointOwnedByDesktop(terminalBrowserEndpoint, pid),
      readCdpVersion(terminalBrowserEndpoint),
    ]);
  if (
    !desktopOwned ||
    !desktopTarget ||
    !terminalOwned ||
    terminalVersion?.["Runweave-Surface"] !== "terminal-browser" ||
    terminalVersion?.["Runweave-Instance-Id"] !== paths.instanceId ||
    terminalVersion?.["Runweave-Dev-Session-Id"] !==
      desktopState.devSessionId ||
    terminalVersion?.["Runweave-Source-Revision"] !==
      desktopState.sourceRevision ||
    terminalVersion?.["Runweave-Pid"] !== pid
  ) {
    return {
      ok: false,
      running: true,
      reason: "Beta desktop CDP identity drifted",
      desktopState,
    };
  }
  return {
    ...processOwnership,
    ok: true,
    reason: null,
  };
}

export async function readCdpVersion(endpoint) {
  if (!endpoint) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(
      `${String(endpoint).replace(/\/$/, "")}/json/version`,
      { signal: controller.signal },
    );
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function buildBetaStatus(paths) {
  const [state, desktopState, runtimeReleaseId, appServerReleaseId] =
    await Promise.all([
      readJson(paths.statePath),
      readJson(paths.desktopStatusPath),
      readReleaseId(paths.runtimeCurrentPath),
      readReleaseId(paths.appServerCurrentPath),
    ]);
  const appServerLockPath =
    desktopState?.appServer?.lockPath ?? paths.appServerLockPath;
  const appServerLock = await readJson(appServerLockPath);
  const desktopPid = desktopState?.app?.pid ?? null;
  const desktopPath = desktopState?.app?.path ?? paths.appPath;
  const desktopExecutable = desktopState?.app?.executable ?? null;
  const desktopProcessSignature = await readProcessSignature(desktopPid);
  const expectedExecutableRoot = path.join(paths.appPath, "Contents", "MacOS");
  const desktopLive =
    desktopState?.channel === BETA_CHANNEL &&
    desktopState?.instanceId === paths.instanceId &&
    desktopPath === paths.appPath &&
    desktopState?.app?.userDataPath === paths.userData &&
    typeof desktopExecutable === "string" &&
    path
      .resolve(desktopExecutable)
      .startsWith(`${expectedExecutableRoot}${path.sep}`) &&
    desktopState?.app?.processSignature === desktopProcessSignature &&
    desktopProcessSignature.includes(desktopExecutable);
  const backendPid = desktopState?.backend?.pid ?? null;
  const backendLive =
    desktopLive &&
    desktopState?.backend?.available === true &&
    isPidLive(backendPid);
  const desktopAppServerPid = desktopState?.appServer?.pid;
  const appServerPid =
    Number.isInteger(desktopAppServerPid) && desktopAppServerPid > 0
      ? desktopAppServerPid
      : (appServerLock?.pid ?? null);
  const appServerBaseUrl =
    desktopState?.appServer?.baseUrl ??
    (appServerLock?.host === "127.0.0.1" &&
    Number.isInteger(appServerLock?.port)
      ? `http://127.0.0.1:${appServerLock.port}`
      : null);
  const desktopCdpEndpoint =
    desktopState?.cdp?.desktop?.endpoint ?? desktopState?.cdp?.endpoint ?? null;
  const terminalBrowserCdpEndpoint =
    desktopState?.cdp?.terminalBrowser?.endpoint ?? null;
  const [
    appServerHealthy,
    desktopCdpHealthy,
    terminalBrowserVersion,
    terminalBrowserOwned,
  ] = await Promise.all([
    isPidLive(appServerPid)
      ? isHttpHealthy(appServerBaseUrl ? `${appServerBaseUrl}/healthz` : null)
      : false,
    desktopLive && desktopCdpEndpoint
      ? Promise.all([
          isCdpEndpointOwnedByDesktop(desktopCdpEndpoint, desktopPid),
          hasCdpPageTarget(desktopCdpEndpoint),
        ]).then((checks) => checks.every(Boolean))
      : false,
    desktopLive && terminalBrowserCdpEndpoint
      ? readCdpVersion(terminalBrowserCdpEndpoint)
      : null,
    desktopLive && terminalBrowserCdpEndpoint
      ? isCdpEndpointOwnedByDesktop(terminalBrowserCdpEndpoint, desktopPid)
      : false,
  ]);
  const terminalBrowserCdpHealthy =
    terminalBrowserOwned &&
    terminalBrowserVersion?.["Runweave-Surface"] === "terminal-browser" &&
    terminalBrowserVersion?.["Runweave-Instance-Id"] === paths.instanceId &&
    terminalBrowserVersion?.["Runweave-Dev-Session-Id"] ===
      (desktopState?.devSessionId ?? paths.devSessionId) &&
    terminalBrowserVersion?.["Runweave-Source-Revision"] ===
      desktopState?.sourceRevision &&
    terminalBrowserVersion?.["Runweave-Pid"] === desktopPid;
  const cdpHealthy = desktopCdpHealthy && terminalBrowserCdpHealthy;

  return {
    schemaVersion: 1,
    channel: BETA_CHANNEL,
    instanceId: paths.instanceId,
    slotId: paths.slotId,
    poolPolicy: paths.poolPolicy,
    devSessionId: desktopState?.devSessionId ?? paths.devSessionId,
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
      profileDir: desktopState?.backend?.profileDir ?? paths.profileDir,
      cliConfigPath: paths.cliConfigPath,
      profileLockPath: path.join(
        desktopState?.backend?.profileDir ?? paths.profileDir,
        "backend.lock.json",
      ),
      runtimeHome: paths.runtimeHome,
      runtimeReleaseId:
        runtimeReleaseId ?? desktopState?.backend?.runtimeReleaseId ?? null,
    },
    appServer: {
      baseUrl: appServerHealthy ? appServerBaseUrl : null,
      cloudSyncDir: paths.appServerCloudSyncDir,
      eventLogPath: paths.appServerEventLogPath,
      healthy: appServerHealthy,
      home: desktopState?.appServer?.home ?? paths.appServerHome,
      lockPath: appServerLockPath,
      logPath: paths.appServerLogPath,
      pid: appServerHealthy ? appServerPid : null,
      releaseId: appServerReleaseId ?? appServerLock?.releaseId ?? null,
      runtimeRoot: path.join(paths.appServerHome, "runtime"),
    },
    cdp: {
      endpoint: desktopCdpHealthy ? desktopCdpEndpoint : null,
      healthy: cdpHealthy,
      desktop: {
        endpoint: desktopCdpHealthy ? desktopCdpEndpoint : null,
        healthy: desktopCdpHealthy,
        pid: desktopCdpHealthy ? desktopPid : null,
      },
      terminalBrowser: {
        endpoint: terminalBrowserCdpHealthy ? terminalBrowserCdpEndpoint : null,
        healthy: terminalBrowserCdpHealthy,
        pid: terminalBrowserCdpHealthy ? desktopPid : null,
      },
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
