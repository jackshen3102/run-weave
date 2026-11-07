import type pg from "pg";
import type { MaterialInput, MaterialMetadata, SuijiRecord } from "@runweave/shared/suiji";
import { digest } from "../records/mutations";

export async function getMaterial(client: Pick<pg.Pool, "query">, owner: string, record: SuijiRecord): Promise<MaterialMetadata | null> {
  const row = (await client.query(`SELECT *,material_date::text AS date FROM record_materials WHERE owner_id=$1 AND record_id=$2`, [owner, record.id])).rows[0];
  if (!row) return null;
  const value: MaterialInput = { captureId: row.capture_id, capturedAt: row.captured_at.toISOString(),
    materialDate: row.date, inputType: row.input_type, ...(row.source_url ? { sourceUrl: row.source_url } : {}) };
  const attachments = (await client.query(`SELECT a.id,a.sha256 FROM record_attachments ra JOIN attachments a
    ON a.owner_id=ra.owner_id AND a.id=ra.attachment_id WHERE ra.owner_id=$1 AND ra.record_id=$2 ORDER BY ra.position`, [owner, record.id])).rows;
  return { ...value, sourceHash: digest({ body: record.body, version: record.version, material: value, attachments }),
    processedVersion: row.processed_version, processedAt: row.processed_at?.toISOString() ?? null };
}

