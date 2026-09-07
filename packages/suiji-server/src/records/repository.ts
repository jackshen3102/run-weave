import type pg from "pg";
import type { SuijiRecord, SuijiAttachment } from "@runweave/shared/suiji";
import { missing } from "../errors";
export async function getRecord(
  client: Pick<pg.Pool, "query"> | pg.PoolClient,
  ownerId: string,
  id: string,
  lock = false,
): Promise<SuijiRecord> {
  const row = (
    await client.query(
      `SELECT * FROM records WHERE owner_id=$1 AND id=$2 ${lock ? "FOR UPDATE" : ""}`,
      [ownerId, id],
    )
  ).rows[0];
  if (!row) throw missing();
  const attachments = (
    await client.query(
      `SELECT a.id,a.kind,a.file_name AS "fileName",a.mime_type AS "mimeType",a.byte_size AS "byteSize",ra.position FROM record_attachments ra JOIN attachments a ON a.owner_id=ra.owner_id AND a.id=ra.attachment_id WHERE ra.owner_id=$1 AND ra.record_id=$2 ORDER BY ra.position`,
      [ownerId, id],
    )
  ).rows as SuijiAttachment[];
  return {
    id: row.id,
    kind: row.kind,
    body: row.body,
    taskStatus: row.task_status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdVia: row.created_via,
    attachments,
  };
}
