import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BETA_UPDATE_APP_NAME,
  resolveBetaUpdateTargets,
} from "./runweave-update-core.mjs";

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
) {
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

export function isPidLive(pid) {
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

export async function runCapture(command, args, options = {}) {
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

export async function hasCdpPageTarget(endpoint) {
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

export async function buildBetaStatus(paths) {
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
