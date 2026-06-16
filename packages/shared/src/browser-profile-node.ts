import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export const BROWSER_PROFILE_LOCK_FILE_NAME = "backend.lock.json";

export interface BrowserProfileStorageEnv {
  BROWSER_PROFILE_DIR?: string;
}

export interface BackendProfileLockOwner {
  backendId: string;
  pid: number;
  port: number | null;
  host: string | null;
  cwd: string;
  startedAt: string;
  runtimeReleaseId: string | null;
}

export interface CreateBackendProfileLockOwnerOptions {
  port: number | null;
  host: string | undefined;
  cwd?: string;
  runtimeReleaseId?: string | undefined;
}

export function expandHomePath(
  inputPath: string | undefined,
  homeDir: string = os.homedir(),
): string | undefined {
  const trimmedPath = inputPath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  if (trimmedPath === "~") {
    return homeDir;
  }

  if (trimmedPath.startsWith("~/")) {
    return path.join(homeDir, trimmedPath.slice(2));
  }

  return trimmedPath;
}

export function resolveDefaultBrowserProfileDir(
  projectPath: string = process.cwd(),
  homeDir: string = os.homedir(),
): string {
  const trimmedProjectPath = projectPath.trim();
  const defaultProfileRootDir = path.join(homeDir, ".browser-profile");
  if (!trimmedProjectPath) {
    return defaultProfileRootDir;
  }

  return path.join(
    defaultProfileRootDir,
    createHash("sha256").update(trimmedProjectPath).digest("hex").slice(0, 8),
  );
}

export function resolveBrowserProfileDir(
  env: BrowserProfileStorageEnv,
  homeDir: string = os.homedir(),
  projectPath: string = process.cwd(),
): string {
  return path.resolve(
    expandHomePath(env.BROWSER_PROFILE_DIR, homeDir) ??
      resolveDefaultBrowserProfileDir(projectPath, homeDir),
  );
}

export function getBrowserProfileLockFile(profileDir: string): string {
  return path.join(profileDir, BROWSER_PROFILE_LOCK_FILE_NAME);
}

export function createBackendProfileLockOwner(
  options: CreateBackendProfileLockOwnerOptions,
): BackendProfileLockOwner {
  return {
    backendId: randomUUID(),
    pid: process.pid,
    port: options.port,
    host: options.host ?? null,
    cwd: options.cwd ?? process.cwd(),
    startedAt: new Date().toISOString(),
    runtimeReleaseId: options.runtimeReleaseId?.trim() || null,
  };
}

export function parseBackendProfileLockOwner(
  value: unknown,
): BackendProfileLockOwner | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const owner = value as Partial<BackendProfileLockOwner>;
  if (
    typeof owner.backendId !== "string" ||
    typeof owner.pid !== "number" ||
    !Number.isInteger(owner.pid)
  ) {
    return null;
  }

  return {
    backendId: owner.backendId,
    pid: owner.pid,
    port:
      typeof owner.port === "number" && Number.isInteger(owner.port)
        ? owner.port
        : null,
    host: typeof owner.host === "string" ? owner.host : null,
    cwd: typeof owner.cwd === "string" ? owner.cwd : "",
    startedAt: typeof owner.startedAt === "string" ? owner.startedAt : "",
    runtimeReleaseId:
      typeof owner.runtimeReleaseId === "string"
        ? owner.runtimeReleaseId
        : null,
  };
}

export async function readBackendProfileLockOwner(
  lockFile: string,
): Promise<BackendProfileLockOwner | null> {
  try {
    return parseBackendProfileLockOwner(
      JSON.parse(await readFile(lockFile, "utf-8")),
    );
  } catch {
    return null;
  }
}

export function isProcessLive(pid: number): boolean {
  if (pid < 1) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isBackendProfileLockOwnerLive(
  owner: BackendProfileLockOwner | null,
): boolean {
  return owner !== null && isProcessLive(owner.pid);
}

export function killProcessIfLive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

export async function readParentPid(pid: number): Promise<number | null> {
  return await new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=", "-p", String(pid)], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }

      const parentPid = Number.parseInt(stdout.trim(), 10);
      resolve(Number.isInteger(parentPid) ? parentPid : null);
    });
  });
}

export async function readProcessCommand(pid: number): Promise<string | null> {
  return await new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }

      resolve(stdout.trim() || null);
    });
  });
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessLive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export function serializeBackendProfileLockOwner(
  owner: BackendProfileLockOwner,
): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

export function formatBackendProfileLockConflict(
  profileDir: string,
  lockFile: string,
  owner: BackendProfileLockOwner | null,
  extraFields: Record<string, unknown> = {},
): string {
  if (!owner) {
    return `Browser profile is locked by another backend startup: ${profileDir} (${lockFile})`;
  }

  const parts = [
    `Browser profile is already in use: ${profileDir}`,
    `owner pid=${owner.pid}`,
    `port=${owner.port ?? "unknown"}`,
    `cwd=${owner.cwd || "unknown"}`,
    `runtimeReleaseId=${owner.runtimeReleaseId ?? "unknown"}`,
  ];

  for (const [key, value] of Object.entries(extraFields)) {
    parts.push(`${key}=${value ?? "unknown"}`);
  }

  return parts.join("; ");
}
