import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { BrowseDigest, BrowseDigestInput } from "@runweave/shared/suiji";
import { digest } from "../records/mutations";
import { invalid, ServiceError } from "../errors";
import { lockHead, getEntry } from "./repository";
export async function listDigests(
  c: Pick<pg.Pool, "query">,
  owner: string,
  input: { date: string; connectionId: string },
): Promise<{ items: BrowseDigest[] }> {
  const rows = await c.query(
    `SELECT id,digest_date::text AS date,connection_id AS "connectionId",title,body,version,entry_refs AS "entryRefs",input_revision::text AS "inputRevision",state FROM browse_digests WHERE owner_id=$1 AND digest_date=$2 AND connection_id=$3`,
    [owner, input.date, input.connectionId],
  );
  return { items: rows.rows };
}
export async function publishDigest(
  c: pg.PoolClient,
  owner: string,
  input: BrowseDigestInput,
) {
  const revision = await lockHead(c, owner);
  if (new Set(input.entryRefs.map((r) => r.id)).size !== input.entryRefs.length)
    throw invalid("摘要引用不能重复");
  const ids = (
    await c.query(
      "SELECT id FROM browse_entries WHERE owner_id=$1 AND browse_date=$2 AND connection_id=$3 AND deleted_at IS NULL ORDER BY id",
      [owner, input.date, input.connectionId],
    )
  ).rows.map((r) => r.id);
  if (digest(ids) !== digest(input.entryRefs.map((r) => r.id).sort()))
    throw invalid("摘要必须覆盖该来源当日全部有效条目");
  for (const ref of input.entryRefs) {
    const entry = await getEntry(c, owner, ref.id);
    if (
      entry.version !== ref.version ||
      entry.contentHash !== ref.hash ||
      entry.deletedAt
    )
      throw new ServiceError(409, "VERSION_CONFLICT", "摘要引用已变化");
  }
  const refs = [...input.entryRefs];
  const canonicalRefs = (value: typeof refs) =>
    [...value].sort((a, b) => a.id.localeCompare(b.id));
  const old = (await listDigests(c, owner, input)).items[0];
  if (
    old &&
    old.state === "current" &&
    digest(canonicalRefs(old.entryRefs)) === digest(canonicalRefs(refs))
  )
    return { digest: old };
  if (input.inputRevision !== revision)
    throw new ServiceError(
      409,
      "VERSION_CONFLICT",
      "浏览输入已变化，请重新读取",
    );
  await c.query(
    `INSERT INTO browse_digests(owner_id,id,digest_date,connection_id,title,body,entry_refs,input_revision,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'current') ON CONFLICT(owner_id,digest_date,connection_id) DO UPDATE SET title=excluded.title,body=excluded.body,entry_refs=excluded.entry_refs,input_revision=excluded.input_revision,state='current',version=browse_digests.version+1`,
    [
      owner,
      randomUUID(),
      input.date,
      input.connectionId,
      input.title,
      input.body,
      JSON.stringify(refs),
      input.inputRevision,
    ],
  );
  const value = (await listDigests(c, owner, input)).items[0]!;
  const next = (
    await c.query(
      "UPDATE browse_heads SET revision=revision+1 WHERE owner_id=$1 RETURNING revision::text",
      [owner],
    )
  ).rows[0].revision;
  await c.query(
    "INSERT INTO browse_changes(owner_id,revision,digest_id,kind,version,deleted) VALUES($1,$2,$3,'digest',$4,false)",
    [owner, next, value.id, value.version],
  );
  return { digest: value };
}
