import fs from "node:fs/promises";
import { quitBeta, runAppServerCli, withBetaLock } from "./operations.mjs";
import { isPidLive, readJson } from "./state.mjs";

// Shared with the installed resource helper. Never execute a source worktree's control script.
export async function stopManagedBeta(
  paths,
  { sharedAppServer = false, sourceRevision = null } = {},
) {
  await withBetaLock(paths, async () => {
    await quitBeta(paths);
    if (sharedAppServer) return;
    const exists = await fs.access(paths.controlCliPath).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (!exists) {
      const lock = await readJson(paths.appServerLockPath);
      if (lock?.pid && isPidLive(lock.pid))
        throw new Error("cannot stop a live Beta App Server without its CLI");
    } else {
      const result = await runAppServerCli(paths, "stop", sourceRevision);
      if (!result.ok && !/not running/i.test(result.stderr))
        throw new Error(`failed to stop Beta App Server: ${result.stderr}`);
    }
  });
}
