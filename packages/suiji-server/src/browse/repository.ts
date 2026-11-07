import type pg from "pg";
import type { BrowseEntry, BrowseEntryInput } from "@runweave/shared/suiji";
import { digest } from "../records/mutations";
import { invalid, missing } from "../errors";
type Client = Pick<pg.Pool, "query">;
export async function lockHead(client: Client, owner: string) {
  await client.query(
    "INSERT INTO browse_heads(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
    [owner],
  );
  return (
    await client.query(
      "SELECT revision::text FROM browse_heads WHERE owner_id=$1 FOR UPDATE",
      [owner],
    )
  ).rows[0].revision as string;
}
export async function head(client: Client, owner: string) {
  return (
    ((
      await client.query(
        "SELECT revision::text FROM browse_heads WHERE owner_id=$1",
        [owner],
      )
    ).rows[0]?.revision as string) ?? "0"
  );
}
export async function getEntry(
  client: Client,
  owner: string,
  id: string,
): Promise<BrowseEntry> {
  const r = (
    await client.query(
      "SELECT *,browse_date::text AS day FROM browse_entries WHERE owner_id=$1 AND id=$2",
      [owner, id],
    )
  ).rows[0];
  if (!r) throw missing();
  const attachments = (
    await client.query(
      `SELECT a.id,a.kind,a.file_name AS "fileName",a.mime_type AS "mimeType",a.byte_size AS "byteSize",b.position
    FROM browse_attachments b JOIN attachments a ON a.owner_id=b.owner_id AND a.id=b.attachment_id
    WHERE b.owner_id=$1 AND b.entry_id=$2 ORDER BY b.position`,
      [owner, id],
    )
  ).rows;
  return {
    id: r.id,
    captureId: r.capture_id,
    version: r.version,
    browseDate: r.day,
    occurredAt: r.occurred_at?.toISOString() ?? null,
    capturedAt: r.captured_at.toISOString(),
    title: r.title,
    body: r.body,
    userNote: r.user_note,
    source: r.source,
    contentType: r.content_type,
    captureMethod: r.capture_method,
    sourceUrl: r.source_url,
    contentState: r.content_state,
    contentHash: r.content_hash,
    deletedAt: r.deleted_at?.toISOString() ?? null,
    attachments,
  };
}
export function contentHash(input: BrowseEntryInput) {
  return digest({
    title: input.title,
    body: input.body,
    sourceUrl: input.sourceUrl,
    contentState: input.contentState,
  });
}
export async function insertEntry(
  client: Client,
  owner: string,
  id: string,
  input: BrowseEntryInput,
  external?: { connectionId: string; type: string; id: string },
) {
  await client.query(
    `INSERT INTO browse_entries(owner_id,id,capture_id,capture_hash,browse_date,occurred_at,captured_at,title,body,user_note,source,content_type,capture_method,source_url,content_state,content_hash,connection_id,external_content_type,external_content_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      owner,
      id,
      input.captureId,
      digest(input),
      input.browseDate,
      input.occurredAt,
      input.capturedAt,
      input.title,
      input.body,
      input.userNote,
      JSON.stringify(input.source),
      input.contentType,
      input.captureMethod,
      input.sourceUrl,
      JSON.stringify(input.contentState),
      contentHash(input),
      external?.connectionId ?? null,
      external?.type ?? null,
      external?.id ?? null,
    ],
  );
}
export async function attach(
  client: Client,
  owner: string,
  id: string,
  ids: string[],
) {
  if (new Set(ids).size !== ids.length) throw invalid("附件不能重复");
  const rows = (
    await client.query(
      "SELECT id,kind,bound_record_id,bound_browse_id FROM attachments WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [owner, ids],
    )
  ).rows;
  if (rows.length !== ids.length) throw missing();
  if (
    rows.some(
      (r) =>
        r.bound_record_id || (r.bound_browse_id && r.bound_browse_id !== id),
    )
  )
    throw invalid("附件已绑定其他条目");
  if (
    rows.filter((r) => r.kind === "image").length > 1 ||
    rows.filter((r) => r.kind === "markdown").length > 1
  )
    throw invalid("最多一张图片和一个 Markdown 附件");
  await client.query(
    "UPDATE attachments SET bound_browse_id=$3 WHERE owner_id=$1 AND id=ANY($2::uuid[])",
    [owner, ids, id],
  );
  await client.query(
    "DELETE FROM browse_attachments WHERE owner_id=$1 AND entry_id=$2",
    [owner, id],
  );
  for (const [position, attachment] of ids.entries())
    await client.query("INSERT INTO browse_attachments VALUES($1,$2,$3,$4)", [
      owner,
      id,
      attachment,
      position,
    ]);
}
export async function snapshot(client: Client, owner: string, id: string) {
  const entry = await getEntry(client, owner, id);
  const revision = (
    await client.query(
      "UPDATE browse_heads SET revision=revision+1 WHERE owner_id=$1 RETURNING revision::text",
      [owner],
    )
  ).rows[0].revision;
  await client.query("INSERT INTO browse_revisions VALUES($1,$2,$3,$4)", [
    owner,
    id,
    entry.version,
    JSON.stringify(entry),
  ]);
  await client.query(
    "INSERT INTO browse_changes(owner_id,revision,entry_id,version,deleted,kind) VALUES($1,$2,$3,$4,$5,'entry')",
    [owner, revision, id, entry.version, Boolean(entry.deletedAt)],
  );
  await client.query(
    `UPDATE browse_digests SET state='stale' WHERE owner_id=$1 AND (entry_refs @> $2::jsonb OR (digest_date=$3 AND connection_id=$4))`,
    [
      owner,
      JSON.stringify([{ id }]),
      entry.browseDate,
      entry.source.connectionId,
    ],
  );
  return entry;
}
