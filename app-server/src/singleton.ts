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
}

export type SingletonPreflightResult =
  | { status: "available" }
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

export async function writeLock(
  lockPath: string,
  lock: AppServerLock,
): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

export async function releaseLock(lockPath: string): Promise<void> {
  const current = await readLock(lockPath);
  if (!current || current.pid !== process.pid) {
    return;
  }
  await rm(lockPath, { force: true });
}

async function readLock(lockPath: string): Promise<AppServerLock | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    if (!isLock(parsed)) {
      return null;
    }
    return parsed;
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
    record.host === "127.0.0.1" &&
    typeof record.port === "number" &&
    typeof record.startedAt === "string" &&
    typeof record.version === "string"
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
