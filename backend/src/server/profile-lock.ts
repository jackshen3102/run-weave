import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  createBackendProfileLockOwner,
  formatBackendProfileLockConflict,
  getBrowserProfileLockFile,
  isBackendProfileLockOwnerLive,
  parseBackendProfileLockOwner,
  serializeBackendProfileLockOwner,
  type BackendProfileLockOwner,
} from "@runweave/shared/browser-profile-node";

interface AcquireBackendProfileLockOptions {
  devSessionId?: string | undefined;
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
    super(formatBackendProfileLockConflict(profileDir, lockFile, owner));
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
    const nextOwner = { ...this.owner, ...fields };
    await replaceLockFile(
      this.profileDir,
      this.lockFile,
      this.owner,
      nextOwner,
    );
    this.owner = nextOwner;
  }

  async release(): Promise<void> {
    const current = await readLockFile(this.lockFile);
    const currentOwner = current?.owner ?? null;
    if (
      !current ||
      currentOwner?.backendId !== this.owner.backendId ||
      currentOwner.pid !== this.owner.pid
    ) {
      return;
    }

    await unlinkIfSameFile(this.lockFile, current.stats);
  }
}

export async function acquireBackendProfileLock(
  options: AcquireBackendProfileLockOptions,
): Promise<BackendProfileLock> {
  await mkdir(options.profileDir, { recursive: true });
  const lockFile = getBrowserProfileLockFile(options.profileDir);
  const owner = createBackendProfileLockOwner(options);

  for (;;) {
    const acquired = await tryCreateLockFile(lockFile, owner);
    if (acquired) {
      return new BackendProfileLock(options.profileDir, lockFile, owner);
    }

    const existing = await readLockFile(lockFile);
    if (!existing) {
      continue;
    }
    const existingOwner = existing.owner;
    if (isBackendProfileLockOwnerLive(existingOwner)) {
      throw new BackendProfileLockConflictError(
        options.profileDir,
        lockFile,
        existingOwner,
      );
    }

    if (!existingOwner) {
      throw new BackendProfileLockConflictError(
        options.profileDir,
        lockFile,
        null,
      );
    }

    await unlinkIfSameFile(lockFile, existing.stats);
  }
}

async function tryCreateLockFile(
  lockFile: string,
  owner: BackendProfileLockOwner,
): Promise<boolean> {
  const candidate = await createLockCandidate(lockFile, owner);
  let published = false;
  try {
    await link(candidate.path, lockFile);
    published = true;
    const publishedStats = await lstat(lockFile);
    if (!sameFileIdentity(candidate.stats, publishedStats)) {
      throw new Error("Published backend profile lock identity changed");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    if (published) {
      await unlinkIfSameFile(lockFile, candidate.stats).catch(() => false);
    }
    throw error;
  } finally {
    await unlink(candidate.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function replaceLockFile(
  profileDir: string,
  lockFile: string,
  expectedOwner: BackendProfileLockOwner,
  nextOwner: BackendProfileLockOwner,
): Promise<void> {
  const current = await readLockFile(lockFile);
  if (!current || !sameOwner(current.owner, expectedOwner)) {
    throw new BackendProfileLockConflictError(
      profileDir,
      lockFile,
      current?.owner ?? null,
    );
  }
  const candidate = await createLockCandidate(lockFile, nextOwner);
  let replaced = false;
  try {
    const beforeReplace = await readLockFile(lockFile);
    if (
      !beforeReplace ||
      !sameOwner(beforeReplace.owner, expectedOwner) ||
      !sameFileIdentity(beforeReplace.stats, current.stats)
    ) {
      throw new BackendProfileLockConflictError(
        profileDir,
        lockFile,
        beforeReplace?.owner ?? null,
      );
    }
    await rename(candidate.path, lockFile);
    replaced = true;
    const publishedStats = await lstat(lockFile);
    if (!sameFileIdentity(candidate.stats, publishedStats)) {
      throw new Error("Updated backend profile lock identity changed");
    }
  } finally {
    if (!replaced) {
      await unlink(candidate.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }
}

async function createLockCandidate(
  lockFile: string,
  owner: BackendProfileLockOwner,
): Promise<{ path: string; stats: { dev: number; ino: number } }> {
  const candidatePath = path.join(
    path.dirname(lockFile),
    `.${path.basename(lockFile)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(candidatePath, "wx", 0o600);
    const stats = await handle.stat();
    await handle.writeFile(serializeBackendProfileLockOwner(owner), {
      encoding: "utf-8",
    });
    await handle.chmod(0o600);
    await handle.sync();
    return { path: candidatePath, stats };
  } catch (error) {
    await unlink(candidatePath).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readLockFile(lockFile: string): Promise<{
  owner: BackendProfileLockOwner | null;
  stats: { dev: number; ino: number };
} | null> {
  let handle;
  try {
    handle = await open(lockFile, "r");
    const stats = await handle.stat();
    let owner: BackendProfileLockOwner | null = null;
    try {
      owner = parseBackendProfileLockOwner(
        JSON.parse(await handle.readFile("utf-8")),
      );
    } catch {
      // Invalid legacy/corrupt locks are preserved so ownership fails closed.
    }
    return { owner, stats };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function sameOwner(
  current: BackendProfileLockOwner | null | undefined,
  expected: BackendProfileLockOwner,
): boolean {
  return (
    current?.backendId === expected.backendId && current.pid === expected.pid
  );
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkIfSameFile(
  filePath: string,
  expected: { dev: number; ino: number },
): Promise<boolean> {
  let current;
  try {
    current = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!sameFileIdentity(current, expected)) {
    return false;
  }
  await unlink(filePath);
  return true;
}
