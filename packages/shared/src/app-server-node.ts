import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APP_SERVER_SERVICE_NAME = "runweave-app-server";
export const APP_SERVER_PROTOCOL_VERSION = 1;

export interface AppServerLock {
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
  version: string;
}

export interface AppServerConnectionInfo {
  baseUrl: string;
  token: string;
}

export interface AppServerHealth {
  ok: boolean;
  service: string;
  protocolVersion: number;
  pid: number;
  version?: string;
}

export interface AppServerStatus {
  available: boolean;
  baseUrl: string | null;
  hasToken: boolean;
  health: AppServerHealth | null;
  lock: AppServerLock | null;
  lockPath: string;
  pid: number | null;
  stateDir: string;
  staleLock: boolean;
  tokenPath: string;
}

export interface AppServerStatePaths {
  stateDir: string;
  lockPath: string;
  tokenPath: string;
  eventLogPath: string;
  logPath: string;
}

export function resolveAppServerStatePaths(
  options: {
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): AppServerStatePaths {
  const env = options.env ?? process.env;
  const stateDir = path.resolve(
    expandHomePath(options.stateDir ?? env.RUNWEAVE_APP_SERVER_STATE_DIR) ??
      path.join(os.homedir(), ".runweave", "app-server"),
  );
  return {
    stateDir,
    lockPath: path.join(stateDir, "app-server.lock.json"),
    tokenPath: path.join(stateDir, "app-server-token"),
    eventLogPath: path.join(stateDir, "app-server-events.jsonl"),
    logPath: path.join(stateDir, "app-server.log"),
  };
}

export async function discoverAppServer(
  options: {
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<AppServerConnectionInfo | null> {
  const fromEnv = await discoverFromEnv(options.env ?? process.env);
  if (fromEnv) {
    return fromEnv;
  }

  const status = await getAppServerStatus(options);
  if (!status.available || !status.baseUrl || !status.hasToken) {
    return null;
  }

  const token = await readAppServerToken(status.tokenPath);
  return token ? { baseUrl: status.baseUrl, token } : null;
}

export async function getAppServerStatus(
  options: {
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<AppServerStatus> {
  const paths = resolveAppServerStatePaths(options);
  const lock = await readAppServerLock(paths.lockPath);
  const token = await readAppServerToken(paths.tokenPath);
  const baseUrl =
    lock && lock.host === "127.0.0.1" && Number.isInteger(lock.port)
      ? `http://${lock.host}:${lock.port}`
      : null;
  const health =
    baseUrl && token
      ? await fetchAppServerHealth(baseUrl, {
          expectedPid: lock?.pid ?? null,
        })
      : null;

  return {
    available: Boolean(baseUrl && token && health),
    baseUrl: health && baseUrl ? baseUrl : null,
    hasToken: Boolean(token),
    health,
    lock,
    lockPath: paths.lockPath,
    pid: health?.pid ?? lock?.pid ?? null,
    stateDir: paths.stateDir,
    staleLock: Boolean(lock && !health),
    tokenPath: paths.tokenPath,
  };
}

export async function removeStaleAppServerLock(
  options: {
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  const status = await getAppServerStatus(options);
  if (!status.staleLock) {
    return false;
  }
  await rm(status.lockPath, { force: true });
  return true;
}

export async function fetchAppServerHealth(
  baseUrl: string,
  options: {
    expectedPid?: number | null;
    timeoutMs?: number;
  } = {},
): Promise<AppServerHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1000);
  try {
    const response = await fetch(`${baseUrl}/healthz`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (
      body.ok !== true ||
      body.service !== APP_SERVER_SERVICE_NAME ||
      body.protocolVersion !== APP_SERVER_PROTOCOL_VERSION ||
      typeof body.pid !== "number"
    ) {
      return null;
    }
    if (options.expectedPid != null && body.pid !== options.expectedPid) {
      return null;
    }
    return {
      ok: true,
      service: APP_SERVER_SERVICE_NAME,
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      pid: body.pid,
      version: typeof body.version === "string" ? body.version : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readAppServerLock(
  lockPath: string,
): Promise<AppServerLock | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    return isAppServerLock(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readAppServerToken(
  tokenPath: string,
): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function expandHomePath(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function discoverFromEnv(
  env: NodeJS.ProcessEnv,
): Promise<AppServerConnectionInfo | null> {
  const baseUrl = env.RUNWEAVE_APP_SERVER_URL?.trim();
  const token = env.RUNWEAVE_APP_SERVER_TOKEN?.trim();
  if (!baseUrl || !token) {
    return null;
  }
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);
  const health = await fetchAppServerHealth(normalizedBaseUrl);
  return health ? { baseUrl: normalizedBaseUrl, token } : null;
}

function isAppServerLock(value: unknown): value is AppServerLock {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    record.host === "127.0.0.1" &&
    typeof record.port === "number" &&
    Number.isInteger(record.port) &&
    record.port > 0 &&
    record.port <= 65535 &&
    typeof record.startedAt === "string" &&
    typeof record.version === "string"
  );
}
