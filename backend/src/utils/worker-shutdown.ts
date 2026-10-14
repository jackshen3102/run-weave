import type { Worker } from "node:worker_threads";

/** Drain queued work before termination, and never wait indefinitely for worker cleanup. */
export async function finishWorkerShutdown(
  worker: Worker,
  exited: Promise<void>,
  errorCode: string,
): Promise<void> {
  const wait = async (milliseconds: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (await wait(2_000)) return;
  void worker.terminate().catch(() => undefined);
  if (!(await wait(500))) throw new Error(errorCode);
}
