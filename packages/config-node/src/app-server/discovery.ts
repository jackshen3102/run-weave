import { settingText, configuration } from "../runtime";
import { readFile, rm } from "node:fs/promises";
import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_SERVICE_NAME,
  type AppServerConnectionInfo,
  type AppServerHealth,
  type AppServerLock,
  type AppServerRuntimeSource,
  type AppServerStatus,
} from "@runweave/shared/app-server/types";
import { resolveAppServerStatePaths, trimTrailingSlash } from "./paths";
import { resolveCurrentAppServerRuntimeRelease } from "./runtime-release";
import { isConfigurationObject, type EnvironmentContext } from "@runweave/shared/configuration";
import { ConfigurationError } from "../errors";

function assertEnvironment(health: AppServerHealth): void {
  const expected = configuration().context;
  if (health.environment?.kind !== expected.kind || health.environment.instanceId !== expected.instanceId || health.environment.configRoot !== expected.configRoot) throw new ConfigurationError("CONFIG_APP_SERVER_IDENTITY_MISMATCH");
}

export async function discoverAppServer(
  options: {
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<AppServerConnectionInfo | null> {
  const env = options.env ?? process.env;
  const discoveryMode = settingText("appServer.discovery");
  if (discoveryMode === "disabled") {
    return null;
  }
  const fromEnv = await discoverFromEnv(env);
  if (fromEnv) {
    return fromEnv;
  }
  if (discoveryMode === "explicit") {
    return null;
  }

  const status = await getAppServerStatus({ ...options, env });
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

  if (health) assertEnvironment(health);
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
    runtimeRoot: paths.runtimeRoot,
    currentRuntime: resolveCurrentAppServerRuntimeRelease({ env: options.env }),
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
      redirect: "error",
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
      environment: isConfigurationObject(body.environment) && ["stable", "dev"].includes(String(body.environment.kind)) && typeof body.environment.instanceId === "string" && typeof body.environment.configRoot === "string" ? body.environment as unknown as EnvironmentContext : undefined,
      pid: body.pid,
      version: typeof body.version === "string" ? body.version : undefined,
      serviceInstanceId:
        typeof body.serviceInstanceId === "string"
          ? body.serviceInstanceId
          : undefined,
      devSessionId:
        typeof body.devSessionId === "string" ? body.devSessionId : undefined,
      sourceRevision:
        typeof body.sourceRevision === "string"
          ? body.sourceRevision
          : undefined,
      capabilities: Array.isArray(body.capabilities)
        ? body.capabilities.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined,
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
    if (isAppServerLock(parsed)) {
      return parsed;
    }
    if (isLegacyAppServerLock(parsed)) {
      return {
        pid: parsed.pid,
        host: parsed.host,
        port: parsed.port,
        startedAt: parsed.startedAt,
        version: parsed.version,
        source: "global",
        releaseId: null,
        entry: "",
        runtimeRoot: null,
      };
    }
    return null;
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

async function discoverFromEnv(
  env: NodeJS.ProcessEnv,
): Promise<AppServerConnectionInfo | null> {
  const baseUrl = env.RUNWEAVE_APP_SERVER_URL?.trim();
  const token = env.RUNWEAVE_APP_SERVER_TOKEN?.trim();
  if (!baseUrl && !token) {
    return null;
  }
  if (!baseUrl || !token) throw new ConfigurationError("CONFIG_APP_SERVER_HANDSHAKE_INCOMPLETE");
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);
  const health = await fetchAppServerHealth(normalizedBaseUrl);
  if (!health) throw new ConfigurationError("CONFIG_APP_SERVER_HANDSHAKE_FAILED");
  assertEnvironment(health);
  return { baseUrl: normalizedBaseUrl, token };
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
    typeof record.version === "string" &&
    isAppServerRuntimeSource(record.source) &&
    (typeof record.releaseId === "string" || record.releaseId === null) &&
    typeof record.entry === "string" &&
    (typeof record.runtimeRoot === "string" || record.runtimeRoot === null) &&
    (typeof record.serviceInstanceId === "string" ||
      record.serviceInstanceId === undefined) &&
    (typeof record.devSessionId === "string" ||
      record.devSessionId === undefined) &&
    (typeof record.sourceRevision === "string" ||
      record.sourceRevision === undefined)
  );
}

function isLegacyAppServerLock(value: unknown): value is {
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
  version: string;
} {
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

function isAppServerRuntimeSource(
  value: unknown,
): value is AppServerRuntimeSource {
  return value === "global" || value === "local" || value === "bundled";
}
