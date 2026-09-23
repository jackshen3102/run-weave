import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tryLock } from "fs-native-extensions";

export async function acquireProcessLock(
  path: string,
  timeoutMs = 0,
  signal?: AbortSignal,
): Promise<{ release(): Promise<void> }> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Keep this inode permanently. Unlinking a locked file allows a second owner
  // to lock a new inode at the same path. Legacy PID files are not lock owners.
  const file = await open(`${path}.native`, "a+", 0o600);
  const deadline = performance.now() + timeoutMs;
  let acquired = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      if (tryLock(file.fd)) {
        acquired = true;
        let released: Promise<void> | undefined;
        return {
          // Closing the descriptor releases the kernel lock, including on crash
          // or reboot. Cache the promise so an old release cannot affect a new FD.
          release: () => (released ??= file.close()),
        };
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Process lock is held: ${path}`);
      await delay(Math.min(50, remaining), undefined, { signal });
    }
  } finally {
    if (!acquired) await file.close();
  }
}
