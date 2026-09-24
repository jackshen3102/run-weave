import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function scheduledTaskDatabasePath({ beta = false } = {}) {
  const profileDir = beta
    ? process.env.BROWSER_PROFILE_DIR
    : path.join(
        os.homedir(),
        ".runweave",
        "browser-profile",
        createHash("sha256").update("/").digest("hex").slice(0, 8),
      );
  if (!profileDir) {
    throw new Error("Cannot determine the target Backend profile for update");
  }
  return path.join(profileDir, "scheduled-tasks", "scheduled-tasks.sqlite");
}

export async function assertNoActiveScheduledRuns(databasePath) {
  if (!existsSync(databasePath)) return;
  const rows = await new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/sqlite3",
      [
        "-readonly",
        databasePath,
        "SELECT id || ':' || status FROM scheduled_runs WHERE status IN ('queued', 'running', 'stopping', 'waiting') LIMIT 5;",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (error += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`Cannot inspect scheduled runs: ${error.trim()}`)),
    );
  });
  if (rows) {
    throw new Error(
      `Desktop update deferred because scheduled runs are active (${rows.replaceAll("\n", ", ")}). Retry after they finish.`,
    );
  }
}
