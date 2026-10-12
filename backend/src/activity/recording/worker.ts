import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ActivityDatabaseOptions } from "../database/connection";

export function resolveWorkerEntry(env: NodeJS.ProcessEnv): URL {
  const configured = env.RUNWEAVE_ACTIVITY_WORKER_ENTRY?.trim();
  if (configured) {
    return pathToFileURL(path.resolve(configured));
  }
  const currentPath = fileURLToPath(import.meta.url);
  return new URL(
    currentPath.endsWith(".ts")
      ? "../database/sqlite-worker.ts"
      : "../database/sqlite-worker.js",
    import.meta.url,
  );
}

const require = createRequire(import.meta.url);

export function createActivityWorker(
  workerEntry: URL,
  workerData: ActivityDatabaseOptions,
): Worker {
  if (!workerEntry.pathname.endsWith(".ts")) {
    return new Worker(workerEntry, { workerData });
  }
  const bootstrap = [
    `require(${JSON.stringify(require.resolve("tsx/cjs"))});`,
    `require(${JSON.stringify(fileURLToPath(workerEntry))});`,
  ].join("\n");
  return new Worker(bootstrap, { eval: true, workerData });
}

export async function waitForActivityWorkerExit(
  exit: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
