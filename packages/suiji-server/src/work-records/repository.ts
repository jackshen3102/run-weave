import type pg from "pg";
import type { WorkFact, WorkField, WorkStatus } from "@runweave/shared/suiji";
import type { Mutation } from "../records/mutations";
import { missing, ServiceError } from "../errors";

export type WorkRow = {
  id: string;
  owner_id: string;
  event_key: string;
  work_date: string;
  title: string;
  statement: string;
  status: WorkStatus;
  project: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_via: "app" | "agent";
  manual_fields: WorkField[];
  source_namespace: string | null;
  external_key: string | null;
  source_snapshot: unknown;
  source_hash: string | null;
  source_collected_at: Date | null;
};
export const columns = "*,work_date::text AS work_date";
export function fact(row: WorkRow): WorkFact {
  return {
    id: row.id,
    eventKey: row.event_key,
    workDate: row.work_date,
    timeZone: "Asia/Shanghai",
    title: row.title,
    statement: row.statement,
    status: row.status,
    project: row.project,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdVia: row.created_via,
    manualFields: row.manual_fields,
  };
}
export async function get(
  client: pg.PoolClient | pg.Pool,
  owner: string,
  id: string,
  lock = false,
): Promise<WorkRow> {
  const row = (
    await client.query<WorkRow>(
      `SELECT ${columns} FROM work_facts WHERE owner_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [owner, id],
    )
  ).rows[0];
  if (!row) throw missing();
  return row;
}
export function checkVersion(row: WorkRow, version: number) {
  if (row.version !== version)
    throw new ServiceError(
      409,
      "VERSION_CONFLICT",
      "事实已更新，请重新读取后核对",
      { currentVersion: row.version },
    );
}
export async function lockHead(client: pg.PoolClient, owner: string) {
  await client.query(
    "INSERT INTO work_feed_heads(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
    [owner],
  );
  return (
    await client.query<{ revision: string }>(
      "SELECT revision::text FROM work_feed_heads WHERE owner_id=$1 FOR UPDATE",
      [owner],
    )
  ).rows[0]!.revision;
}
export async function bump(client: pg.PoolClient, owner: string) {
  return (
    await client.query<{ revision: string }>(
      "UPDATE work_feed_heads SET revision=revision+1 WHERE owner_id=$1 RETURNING revision::text",
      [owner],
    )
  ).rows[0]!.revision;
}
export function changed(currentFeedRevision: string): never {
  throw new ServiceError(
    409,
    "WORK_FEED_CHANGED",
    "工作记录已变化，请重新读取",
    { currentFeedRevision },
  );
}
export async function revision(
  client: pg.PoolClient,
  ctx: Mutation,
  row: WorkRow,
) {
  await client.query(
    "INSERT INTO work_fact_revisions(owner_id,fact_id,version,snapshot,actor,request_id) VALUES($1,$2,$3,$4,$5,$6)",
    [
      ctx.ownerId,
      row.id,
      row.version,
      JSON.stringify(row),
      ctx.actor,
      ctx.requestId,
    ],
  );
}
