import type Database from "better-sqlite3";

export interface ActivityRepositoryBinding {
  eventId: string;
  repositoryId: string | null;
  commonDirectory: string | null;
  reason: string;
}

export function initializeRepositoryIndex(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS activity_repository_bindings (
      binding_offset INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE REFERENCES behavior_facts(event_id) ON DELETE CASCADE,
      repository_id TEXT,
      common_directory TEXT,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_repository_scope_idx
      ON activity_repository_bindings(repository_id, binding_offset);
    CREATE TRIGGER IF NOT EXISTS activity_repository_pending
      AFTER INSERT ON behavior_facts BEGIN
        INSERT OR IGNORE INTO activity_repository_bindings(event_id, reason)
        VALUES (NEW.event_id, 'pending');
      END;
  `);
}

/** A later resolution gets a new cursor, so it cannot disappear behind a watermark. */
export function bindActivityRepositories(
  database: Database.Database,
  bindings: ActivityRepositoryBinding[],
): void {
  const existing = database.prepare(
    "SELECT repository_id, reason FROM activity_repository_bindings WHERE event_id = ?",
  );
  const fact = database.prepare(
    "SELECT 1 FROM behavior_facts WHERE event_id = ?",
  );
  const remove = database.prepare(
    "DELETE FROM activity_repository_bindings WHERE event_id = ? AND repository_id IS NULL",
  );
  const insert = database.prepare(`INSERT INTO activity_repository_bindings
    (event_id, repository_id, common_directory, reason) VALUES (?, ?, ?, ?)`);
  for (const binding of bindings) {
    if (!fact.get(binding.eventId)) continue;
    const previous = existing.get(binding.eventId) as
      | { repository_id: string | null; reason: string }
      | undefined;
    if (previous?.repository_id) {
      if (
        binding.repositoryId &&
        previous.repository_id !== binding.repositoryId
      )
        throw new Error("activity_repository_identity_conflict");
      continue;
    }
    if (
      previous &&
      !previous.repository_id &&
      !binding.repositoryId &&
      previous.reason === binding.reason
    )
      continue;
    remove.run(binding.eventId);
    insert.run(
      binding.eventId,
      binding.repositoryId,
      binding.commonDirectory,
      binding.reason,
    );
  }
}

export function pendingRepositoryFacts(
  database: Database.Database,
): Array<{ eventId: string; cwd: string | null }> {
  return (
    database
      .prepare(
        `SELECT fact.event_id, fact.cwd FROM behavior_facts fact
    JOIN activity_repository_bindings binding ON binding.event_id = fact.event_id
    WHERE binding.reason = 'pending' ORDER BY binding.binding_offset LIMIT 200`,
      )
      .all() as Array<{ event_id: string; cwd: string | null }>
  ).map((row) => ({ eventId: row.event_id, cwd: row.cwd }));
}
