import { configurationLibrary as configuration } from "../lib/configuration.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  readClaim,
  readDescriptor,
  readReceipt,
} from "../background-command-worker/job-store.mjs";

export function scheduledTaskDatabasePath() {
  return path.join(
    configuration.configurationPath(
      "storage.scheduledTasksDirectory",
      "scheduled-tasks",
    ),
    "scheduled-tasks.sqlite",
  );
}

export async function assertNoActiveScheduledRuns(databasePath) {
  if (existsSync(databasePath)) {
    const rows = await queryDatabase(
      databasePath,
      "SELECT id || ':' || status FROM scheduled_runs WHERE status IN ('queued', 'running', 'stopping', 'waiting') LIMIT 5;",
    );
    if (rows) {
      throw new Error(
        `Desktop update deferred because scheduled runs are active (${rows.replaceAll("\n", ", ")}). Retry after they finish.`,
      );
    }
    const commandTable = await queryDatabase(
      databasePath,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_runs';",
    );
    if (commandTable) {
      const commands = await queryDatabase(
        databasePath,
        "SELECT id || ':' || status FROM command_runs WHERE status IN ('queued', 'running', 'stopping', 'waiting') LIMIT 5;",
      );
      if (commands)
        throw new Error(
          `Desktop update deferred because background commands are active (${commands.replaceAll("\n", ", ")}). Retry after they finish.`,
        );
    }
  }
  const root = path.join(path.dirname(databasePath), "background-command-jobs");
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory())
      throw new Error(
        "Desktop update deferred because an update job entry is invalid",
      );
    await readDescriptor(root, entry.name);
    try {
      await readReceipt(root, entry.name);
      const claim = await readClaim(root, entry.name);
      if (await isClaimedWorkerAlive(claim))
        throw new Error(
          `Desktop update deferred because update job ${entry.name} still owns a live worker`,
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error(
        `Desktop update deferred because update job ${entry.name} has no final receipt`,
      );
    }
  }
}

async function isClaimedWorkerAlive(claim) {
  try {
    process.kill(claim.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  const startedAt = await new Promise((resolve, reject) => {
    const child = spawn("/bin/ps", ["-p", String(claim.pid), "-o", "lstart="], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (error += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`Cannot inspect update worker: ${error.trim()}`)),
    );
  });
  return startedAt === claim.startedAt;
}

async function queryDatabase(databasePath, sql) {
  const rows = await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sqlite3", ["-readonly", databasePath, sql], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  return rows;
}
