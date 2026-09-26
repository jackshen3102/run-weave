import { configuration, configurationPath } from "@runweave/config-node";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type Database from "better-sqlite3";

const require = createRequire(import.meta.url);

export interface ExperienceStorage {
  home: string;
  namespace: string;
}

export function resolveExperienceStorage(): ExperienceStorage {
  const { kind, instanceId } = configuration().context;
  return { home: configurationPath("storage.experienceDirectory", "experience"), namespace: kind === "stable" ? "production" : instanceId };
}

type Bucket =
  | "records"
  | "revisions"
  | "lookups"
  | "feedback"
  | "candidates"
  | "jobs";

/** Only short synchronous transactions hold SQLite locks; evidence I/O happens outside.
 * Each operation closes its connection, including on failure. No long-lived owner or worker.
 */
export function withExperienceStore<T>(
  directory: string,
  operation: (store: ExperienceStore) => T,
): T {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "store.sqlite");
  // Packaged Backend lives in app.asar; native modules are staged outside it.
  const Driver = require(
    process.env.RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR ?? "better-sqlite3",
  ) as typeof Database;
  const database = new Driver(file, {
    timeout: 5000,
    nativeBinding: process.env.RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING,
  });
  try {
    chmodSync(file, 0o600);
    database.exec(`CREATE TABLE IF NOT EXISTS documents (
      bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (bucket, id)
    )`);
    return operation(new ExperienceStore(database));
  } finally {
    database.close();
  }
}

class ExperienceStore {
  constructor(private readonly database: Database.Database) {}

  get<T>(bucket: Bucket, id: string): T | undefined {
    const row = this.database
      .prepare("SELECT value FROM documents WHERE bucket = ? AND id = ?")
      .get(bucket, id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  list<T>(bucket: Bucket): T[] {
    const rows = this.database
      .prepare("SELECT value FROM documents WHERE bucket = ? ORDER BY id")
      .all(bucket) as Array<{ value: string }>;
    return rows.map((row) => JSON.parse(row.value) as T);
  }

  put(bucket: Bucket, id: string, value: unknown): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO documents (bucket, id, value) VALUES (?, ?, ?)",
      )
      .run(bucket, id, JSON.stringify(value));
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }
}
