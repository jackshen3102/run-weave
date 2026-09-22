import os from "node:os";
import { mkdtempSync, copyFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { openEvolutionDatabase } from "./sqlite-driver";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { fingerprint, openReadOnly } from "./repository-migration-audit";

export function privateJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}
export function assertOffline(files: string[]): void {
  for (const file of files) {
    let output = "";
    try {
      output = execFileSync(
        process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
        ["-t", "--", file, `${file}-wal`, `${file}-shm`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const result = error as { status?: number; stdout?: string };
      if (result.status !== 1) throw error;
      output = String(result.stdout ?? "");
    }
    if (
      output
        .trim()
        .split(/\s+/u)
        .some((value) => value)
    )
      throw new Error(`migration_database_busy:${file}`);
  }
}
export function acquireMigrationLock(lock: string, migrationId: string): void {
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  if (existsSync(lock)) {
    const owner = JSON.parse(
      readFileSync(path.join(lock, "owner.json"), "utf8"),
    ) as { pid: number; migrationId: string };
    if (
      owner.migrationId !== migrationId ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      throw new Error("migration_lock_conflict");
    try {
      process.kill(owner.pid, 0);
      throw new Error("migration_lock_busy");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    // Only resume the same recorded operation after proving its owner is dead.
    rmSync(lock, { recursive: true });
  }
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, migrationId }),
    { mode: 0o600 },
  );
}
export async function backupDatabase(
  sourceFile: string,
  destination: string,
): Promise<void> {
  const source = openReadOnly(sourceFile);
  try {
    await source.backup(destination);
    chmodSync(destination, 0o600);
  } finally {
    source.close();
  }
}
export function currentFingerprints(files: {
  activity: string;
  evolution: string;
}) {
  const activity = openReadOnly(files.activity),
    evolution = openReadOnly(files.evolution);
  try {
    return {
      activity: fingerprint(activity),
      evolution: fingerprint(evolution),
    };
  } finally {
    activity.close();
    evolution.close();
  }
}
export function databaseClone(file: string): {
  database: Database.Database;
  dispose: () => void;
} {
  // SQLite serialization retains WAL mode and cannot be opened as an in-memory
  // database. The source here is a closed backup, never a live main DB file.
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "runweave-migration-verify-"),
  );
  const clone = path.join(directory, "expected.sqlite");
  copyFileSync(file, clone);
  chmodSync(clone, 0o600);
  const database = openEvolutionDatabase(clone);
  return {
    database,
    dispose: () => {
      database.close();
      rmSync(directory, { recursive: true });
    },
  };
}
