import { mkdir, open, stat, unlink, writeFile } from "node:fs/promises";
import {
  createBackendProfileLockOwner,
  formatBackendProfileLockConflict,
  getBrowserProfileLockFile,
  isBackendProfileLockOwnerLive,
  readBackendProfileLockOwner,
  serializeBackendProfileLockOwner,
  type BackendProfileLockOwner,
} from "@runweave/shared/src/browser-profile-node";

const UNKNOWN_LOCK_STALE_AFTER_MS = 10_000;

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
    this.owner = { ...this.owner, ...fields };
    await writeFile(
      this.lockFile,
      serializeBackendProfileLockOwner(this.owner),
      {
        encoding: "utf-8",
        mode: 0o600,
      },
    );
  }

  async release(): Promise<void> {
    const currentOwner = await readBackendProfileLockOwner(this.lockFile);
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
  const lockFile = getBrowserProfileLockFile(options.profileDir);
  const owner = createBackendProfileLockOwner(options);

  for (;;) {
    const acquired = await tryCreateLockFile(lockFile, owner);
    if (acquired) {
      return new BackendProfileLock(options.profileDir, lockFile, owner);
    }

    const existingOwner = await readBackendProfileLockOwner(lockFile);
    if (isBackendProfileLockOwnerLive(existingOwner)) {
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

async function tryCreateLockFile(
  lockFile: string,
  owner: BackendProfileLockOwner,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(serializeBackendProfileLockOwner(owner), {
      encoding: "utf-8",
    });
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
