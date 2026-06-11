import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_FILE_NAME = "backend.lock.json";
const UNKNOWN_LOCK_STALE_AFTER_MS = 10_000;

export interface BackendProfileLockOwner {
  backendId: string;
  pid: number;
  port: number | null;
  host: string | null;
  cwd: string;
  startedAt: string;
  runtimeReleaseId: string | null;
}

interface AcquireBackendProfileLockOptions {
  profileDir: string;
  port: number | null;
  host: string | undefined;
  cwd?: string;
  runtimeReleaseId?: string | undefined;
}

export class BackendProfileLockConflictError extends Error {
  constructor(
    readonly profileDir: string,
    readonly lockFile: string,
    readonly owner: BackendProfileLockOwner | null,
  ) {
    super(formatConflictMessage(profileDir, lockFile, owner));
    this.name = "BackendProfileLockConflictError";
  }
}

export class BackendProfileLock {
  private owner: BackendProfileLockOwner;

  constructor(
    private readonly profileDir: string,
    private readonly lockFile: string,
    owner: BackendProfileLockOwner,
  ) {
    this.owner = owner;
  }

  getOwner(): BackendProfileLockOwner {
    return { ...this.owner };
  }

  async update(
    fields: Partial<Pick<BackendProfileLockOwner, "host" | "port">>,
  ): Promise<void> {
    this.owner = { ...this.owner, ...fields };
    await writeFile(this.lockFile, serializeOwner(this.owner), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  async release(): Promise<void> {
    const currentOwner = await readLockOwner(this.lockFile);
    if (
      currentOwner?.backendId !== this.owner.backendId ||
      currentOwner.pid !== this.owner.pid
    ) {
      return;
    }

    await unlink(this.lockFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export async function acquireBackendProfileLock(
  options: AcquireBackendProfileLockOptions,
): Promise<BackendProfileLock> {
  await mkdir(options.profileDir, { recursive: true });
  const lockFile = path.join(options.profileDir, LOCK_FILE_NAME);
  const owner = createLockOwner(options);

  for (;;) {
    const acquired = await tryCreateLockFile(lockFile, owner);
    if (acquired) {
      return new BackendProfileLock(options.profileDir, lockFile, owner);
    }

    const existingOwner = await readLockOwner(lockFile);
    if (isLiveOwner(existingOwner)) {
      throw new BackendProfileLockConflictError(
        options.profileDir,
        lockFile,
        existingOwner,
      );
    }

    if (!existingOwner && !(await shouldRemoveUnknownLock(lockFile))) {
      throw new BackendProfileLockConflictError(
        options.profileDir,
        lockFile,
        null,
      );
    }

    await unlink(lockFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

function createLockOwner(
  options: AcquireBackendProfileLockOptions,
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

async function tryCreateLockFile(
  lockFile: string,
  owner: BackendProfileLockOwner,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(serializeOwner(owner), { encoding: "utf-8" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readLockOwner(
  lockFile: string,
): Promise<BackendProfileLockOwner | null> {
  try {
    const rawOwner = await readFile(lockFile, "utf-8");
    const parsedOwner = JSON.parse(rawOwner) as Partial<BackendProfileLockOwner>;
    if (
      typeof parsedOwner.backendId !== "string" ||
      typeof parsedOwner.pid !== "number" ||
      !Number.isInteger(parsedOwner.pid)
    ) {
      return null;
    }

    return {
      backendId: parsedOwner.backendId,
      pid: parsedOwner.pid,
      port:
        typeof parsedOwner.port === "number" && Number.isInteger(parsedOwner.port)
          ? parsedOwner.port
          : null,
      host: typeof parsedOwner.host === "string" ? parsedOwner.host : null,
      cwd: typeof parsedOwner.cwd === "string" ? parsedOwner.cwd : "",
      startedAt:
        typeof parsedOwner.startedAt === "string" ? parsedOwner.startedAt : "",
      runtimeReleaseId:
        typeof parsedOwner.runtimeReleaseId === "string"
          ? parsedOwner.runtimeReleaseId
          : null,
    };
  } catch {
    return null;
  }
}

function isLiveOwner(owner: BackendProfileLockOwner | null): boolean {
  if (owner === null || owner.pid < 1) {
    return false;
  }

  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function shouldRemoveUnknownLock(lockFile: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockFile);
    return Date.now() - lockStat.mtimeMs > UNKNOWN_LOCK_STALE_AFTER_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function serializeOwner(owner: BackendProfileLockOwner): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

function formatConflictMessage(
  profileDir: string,
  lockFile: string,
  owner: BackendProfileLockOwner | null,
): string {
  if (!owner) {
    return `Browser profile is locked by another backend startup: ${profileDir} (${lockFile})`;
  }

  return [
    `Browser profile is already in use: ${profileDir}`,
    `owner pid=${owner.pid}`,
    `port=${owner.port ?? "unknown"}`,
    `cwd=${owner.cwd || "unknown"}`,
    `runtimeReleaseId=${owner.runtimeReleaseId ?? "unknown"}`,
  ].join("; ");
}
