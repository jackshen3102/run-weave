import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const APP_SERVER_SERVICE_NAME = "runweave-app-server";
export const APP_SERVER_PROTOCOL_VERSION = 1;

export interface AppServerLock {
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
  version: string;
  source: "global" | "local" | "bundled";
  releaseId: string | null;
  entry: string;
  runtimeRoot: string | null;
  serviceInstanceId?: string;
  devSessionId?: string;
  sourceRevision?: string;
}

export type SingletonPreflightResult =
  | { status: "available" }
  | { status: "owned"; lock: AppServerLock };

export type SingletonAcquireResult =
  | { status: "acquired" }
  | { status: "owned"; lock: AppServerLock };

export async function preflightSingleton(
  lockPath: string,
): Promise<SingletonPreflightResult> {
  const lock = await readLock(lockPath);
  if (!lock) {
    return { status: "available" };
  }

  if (isPidAlive(lock.pid) && (await healthCheck(lock))) {
    return { status: "owned", lock };
  }

  await rm(lockPath, { force: true });
  return { status: "available" };
}

export async function acquireSingletonLock(
  lockPath: string,
  lock: AppServerLock,
): Promise<SingletonAcquireResult> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { status: "acquired" };
    } catch (error) {
      const code =
        error && typeof error === "object"
          ? (error as NodeJS.ErrnoException).code
          : null;
      if (code !== "EEXIST") {
        throw error;
      }
    }

    const existing = await readAppServerLock(lockPath);
    if (existing && isPidAlive(existing.pid) && (await healthCheck(existing))) {
      return { status: "owned", lock: existing };
    }
    await rm(lockPath, { force: true });
  }

  const existing = await readAppServerLock(lockPath);
  if (existing && isPidAlive(existing.pid) && (await healthCheck(existing))) {
    return { status: "owned", lock: existing };
  }

  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { status: "acquired" };
}

export async function releaseLock(lockPath: string): Promise<void> {
  const current = await readLock(lockPath);
  if (!current || current.pid !== process.pid) {
    return;
  }
  await rm(lockPath, { force: true });
}

async function readLock(lockPath: string): Promise<AppServerLock | null> {
  return readAppServerLock(lockPath);
}

async function readAppServerLock(
  lockPath: string,
): Promise<AppServerLock | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    return isLock(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isLock(value: unknown): value is AppServerLock {
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
    (record.source === "global" ||
      record.source === "local" ||
      record.source === "bundled") &&
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthCheck(lock: AppServerLock): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`http://${lock.host}:${lock.port}/healthz`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as Record<string, unknown>;
    return (
      body.ok === true &&
      body.service === APP_SERVER_SERVICE_NAME &&
      body.protocolVersion === APP_SERVER_PROTOCOL_VERSION &&
      body.pid === lock.pid
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
