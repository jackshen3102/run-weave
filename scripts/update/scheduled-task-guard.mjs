import { configurationLibrary as configuration } from "../lib/configuration.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function scheduledTaskDatabasePath() {
  return path.join(configuration.configurationPath("storage.scheduledTasksDirectory", "scheduled-tasks"), "scheduled-tasks.sqlite");
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
