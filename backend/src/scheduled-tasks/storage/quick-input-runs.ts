import type Database from "better-sqlite3";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import type { StoredRow } from "./validation";

export function listQuickInputRuns(
  database: Database.Database,
  projectId: string | undefined,
  finishedSince: string | undefined,
  parse: (row: StoredRow) => ScheduledRun | null,
): ScheduledRun[] {
  const rows = database.prepare(
    `SELECT * FROM scheduled_runs WHERE json_valid(payload_json)
     AND json_extract(payload_json, '$.snapshot.origin.kind') = 'quick-input'
     AND (? IS NULL OR json_extract(payload_json, '$.snapshot.projectId') = ?)
     AND (? IS NULL OR json_extract(payload_json, '$.finishedAt') >= ?)
     ORDER BY CASE WHEN ? IS NULL THEN scheduled_for END DESC,
              CASE WHEN ? IS NOT NULL THEN json_extract(payload_json, '$.finishedAt') END ASC,
              id ASC`,
  ).all(projectId ?? null, projectId ?? null, finishedSince ?? null,
    finishedSince ?? null, finishedSince ?? null, finishedSince ?? null) as StoredRow[];
  return rows.flatMap((row) => {
    const run = parse(row);
    return run ? [run] : [];
  });
}
