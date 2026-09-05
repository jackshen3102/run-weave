import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function acquireProcessLock(
  path: string,
  timeoutMs = 0,
  signal?: AbortSignal,
): Promise<{ release(): Promise<void> }> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = `${process.pid}\n${randomUUID()}\n`;
  const candidate = `${path}.${randomUUID()}.tmp`;
  await writeFile(candidate, owner, { mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        // Publish a fully written owner record atomically, never an empty lock.
        await link(candidate, path);
        return {
          async release() {
            if ((await readOwner(path)) === owner)
              await rm(path, { force: true });
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const previous = await readOwner(path);
      if (previous === null) continue;
      const pid = Number(previous.split("\n")[0]);
      if (
        previous &&
        Number.isInteger(pid) &&
        pid > 0 &&
        !isProcessAlive(pid)
      ) {
        if ((await readOwner(path)) === previous)
          await rm(path, { force: true });
        continue;
      }
      // Legacy state locks were empty. A live writer holds them for milliseconds.
      if (previous === "" && Date.now() - (await stat(path)).mtimeMs > 30_000) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(`Process lock is held: ${path}`);
      await delay(50, undefined, { signal });
    }
  } finally {
    await rm(candidate, { force: true });
  }
}

async function readOwner(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
