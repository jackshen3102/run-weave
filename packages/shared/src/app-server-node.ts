import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APP_SERVER_SERVICE_NAME = "runweave-app-server";
export const APP_SERVER_PROTOCOL_VERSION = 1;
export const APP_SERVER_RUNTIME_SCHEMA_VERSION = 1;

export type AppServerRuntimeSource = "global" | "local" | "bundled";

export interface AppServerLock {
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
  version: string;
  source: AppServerRuntimeSource;
  releaseId: string | null;
  entry: string;
  runtimeRoot: string | null;
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
  runtimeRoot: string;
  currentRuntime: AppServerRuntimeRelease | null;
}

export interface AppServerStatePaths {
  homeDir: string;
  stateDir: string;
  lockPath: string;
  tokenPath: string;
  eventLogPath: string;
  logPath: string;
  runtimeRoot: string;
  runtimeCurrentPath: string;
  runtimeReleasesDir: string;
}

export interface AppServerRuntimeRelease {
  source: AppServerRuntimeSource;
  releaseId: string;
  entry: string;
  releaseDir: string | null;
  runtimeRoot: string | null;
}

interface AppServerRuntimeManifest {
  schemaVersion?: unknown;
  releaseId?: unknown;
  appServer?: {
    entry?: unknown;
  };
  protocolVersion?: unknown;
  files?: Array<{
    path?: unknown;
    sha256?: unknown;
  }>;
}

interface AppServerRuntimePointer {
  releaseId?: unknown;
}

export function resolveAppServerStatePaths(
  options: {
    homeDir?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): AppServerStatePaths {
  const env = options.env ?? process.env;
  const homeDir = resolveAppServerHomeDir({ homeDir: options.homeDir, env });
  const stateDir = path.resolve(
    expandHomePath(options.stateDir ?? env.RUNWEAVE_APP_SERVER_STATE_DIR) ??
      homeDir,
  );
  const runtimeRoot = resolveAppServerRuntimeRoot({ homeDir, env });
  return {
    homeDir,
    stateDir,
    lockPath: path.join(stateDir, "app-server.lock.json"),
    tokenPath: path.join(stateDir, "app-server-token"),
    eventLogPath: path.join(stateDir, "app-server-events.jsonl"),
    logPath: path.join(stateDir, "app-server.log"),
    runtimeRoot,
    runtimeCurrentPath: path.join(runtimeRoot, "current.json"),
    runtimeReleasesDir: path.join(runtimeRoot, "releases"),
  };
}

export function resolveAppServerHomeDir(
  options: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const env = options.env ?? process.env;
  return path.resolve(
    expandHomePath(options.homeDir ?? env.RUNWEAVE_APP_SERVER_HOME) ??
      path.join(os.homedir(), ".runweave", "app-server"),
  );
}

export function resolveAppServerRuntimeRoot(
  options: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const env = options.env ?? process.env;
  return path.resolve(
    expandHomePath(env.RUNWEAVE_APP_SERVER_RUNTIME_ROOT) ??
      path.join(
        options.homeDir
          ? path.resolve(expandHomePath(options.homeDir) ?? options.homeDir)
          : resolveAppServerHomeDir({ env }),
        "runtime",
      ),
  );
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

export function resolveCurrentAppServerRuntimeRelease(
  options: {
    env?: NodeJS.ProcessEnv;
    runtimeRoot?: string;
  } = {},
): AppServerRuntimeRelease | null {
  const runtimeRoot =
    options.runtimeRoot ?? resolveAppServerRuntimeRoot({ env: options.env });
  const pointer = readJsonFile<AppServerRuntimePointer>(
    path.join(runtimeRoot, "current.json"),
  );
  if (!isSafeReleaseId(pointer?.releaseId)) {
    return null;
  }

  const releaseId = pointer.releaseId;
  const releaseDir = path.join(runtimeRoot, "releases", releaseId);
  const manifest = readJsonFile<AppServerRuntimeManifest>(
    path.join(releaseDir, "manifest.json"),
  );
  if (!isValidAppServerRuntimeManifest(manifest, releaseId)) {
    return null;
  }

  const entry = resolveInside(releaseDir, manifest.appServer.entry);
  if (!entry || !existsSync(entry)) {
    return null;
  }

  for (const file of manifest.files) {
    const filePath = resolveInside(releaseDir, file.path);
    if (!filePath || !existsSync(filePath) || sha256(filePath) !== file.sha256) {
      return null;
    }
  }

  return {
    source: "global",
    releaseId,
    entry,
    releaseDir,
    runtimeRoot,
  };
}

export function installAppServerRuntimeRelease(options: {
  entry: string;
  releaseId: string;
  env?: NodeJS.ProcessEnv;
  runtimeRoot?: string;
}): AppServerRuntimeRelease {
  if (!isSafeReleaseId(options.releaseId)) {
    throw new Error(`Invalid app-server releaseId: ${options.releaseId}`);
  }

  const sourceEntry = path.resolve(options.entry);
  if (!existsSync(sourceEntry)) {
    throw new Error(`App-server entry does not exist: ${sourceEntry}`);
  }

  const runtimeRoot =
    options.runtimeRoot ?? resolveAppServerRuntimeRoot({ env: options.env });
  const releasesDir = path.join(runtimeRoot, "releases");
  const releaseDir = path.join(releasesDir, options.releaseId);
  const tempReleaseDir = path.join(releasesDir, `${options.releaseId}.tmp`);
  const targetEntry = path.join(tempReleaseDir, "app-server", "index.cjs");

  rmSync(tempReleaseDir, { recursive: true, force: true });
  mkdirSync(path.dirname(targetEntry), { recursive: true });
  cpSync(sourceEntry, targetEntry);

  const manifest = {
    schemaVersion: APP_SERVER_RUNTIME_SCHEMA_VERSION,
    releaseId: options.releaseId,
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    appServer: {
      entry: "app-server/index.cjs",
    },
    files: [
      {
        path: "app-server/index.cjs",
        sha256: sha256(targetEntry),
      },
    ],
  };
  writeFileSync(
    path.join(tempReleaseDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  mkdirSync(releasesDir, { recursive: true });
  rmSync(releaseDir, { recursive: true, force: true });
  renameSync(tempReleaseDir, releaseDir);

  const currentPath = path.join(runtimeRoot, "current.json");
  const currentTemp = `${currentPath}.tmp`;
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    currentTemp,
    `${JSON.stringify(
      {
        releaseId: options.releaseId,
        activatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  renameSync(currentTemp, currentPath);

  return {
    source: "global",
    releaseId: options.releaseId,
    entry: path.join(releaseDir, "app-server", "index.cjs"),
    releaseDir,
    runtimeRoot,
  };
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
    typeof record.version === "string" &&
    isAppServerRuntimeSource(record.source) &&
    (typeof record.releaseId === "string" || record.releaseId === null) &&
    typeof record.entry === "string" &&
    (typeof record.runtimeRoot === "string" || record.runtimeRoot === null)
  );
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return false;
  }
  return trimmed
    .split(/[\\/]+/)
    .every((segment) => segment && segment !== "." && segment !== "..");
}

function isSafeReleaseId(value: unknown): value is string {
  return (
    isSafeRelativePath(value) &&
    !String(value).includes("/") &&
    !String(value).includes("\\")
  );
}

function resolveInside(baseDir: string, relativePath: string): string | null {
  const resolved = path.resolve(baseDir, relativePath);
  const base = path.resolve(baseDir);
  if (resolved !== base && resolved.startsWith(`${base}${path.sep}`)) {
    return resolved;
  }
  return null;
}

function isValidAppServerRuntimeManifest(
  manifest: AppServerRuntimeManifest | null,
  releaseId: string,
): manifest is Required<AppServerRuntimeManifest> & {
  appServer: { entry: string };
  files: Array<{ path: string; sha256: string }>;
} {
  return Boolean(
    manifest &&
      manifest.schemaVersion === APP_SERVER_RUNTIME_SCHEMA_VERSION &&
      manifest.releaseId === releaseId &&
      manifest.protocolVersion === APP_SERVER_PROTOCOL_VERSION &&
      isSafeRelativePath(manifest.appServer?.entry) &&
      Array.isArray(manifest.files) &&
      manifest.files.every(
        (file) =>
          isSafeRelativePath(file.path) &&
          typeof file.sha256 === "string" &&
          /^[a-f0-9]{64}$/i.test(file.sha256),
      ),
  );
}

function isAppServerRuntimeSource(
  value: unknown,
): value is AppServerRuntimeSource {
  return value === "global" || value === "local" || value === "bundled";
}
