import type Database from "better-sqlite3";

export function insertImmutable(
  database: Database.Database,
  params: {
    table: string;
    idColumn: string;
    id: string;
    payload: string;
    insert: () => Database.RunResult;
  },
): void {
  const existing = database
    .prepare(
      `SELECT payload_json FROM ${params.table} WHERE ${params.idColumn} = ?`,
    )
    .get(params.id) as { payload_json: string } | undefined;
  if (existing) {
    if (existing.payload_json !== params.payload) {
      throw new Error("evolution_immutable_artifact_conflict");
    }
    return;
  }
  params.insert();
}
