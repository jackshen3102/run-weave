import type pg from "pg";
import {
  emptyFollowupSummary,
  type FollowupSummary,
  type FollowupSource,
  type SuijiFollowup,
  type SuijiAttachment,
} from "@runweave/shared/suiji";

type Client = Pick<pg.Pool, "query">;
type Row = {
  id: string;
  record_id: string;
  sequence: number;
  body: string;
  created_at: Date;
  actor: "app" | "agent";
  agent_name: string | null;
  session_id: string | null;
};
const source = (row: Row): FollowupSource => ({
  actor: row.actor,
  ...(row.agent_name ? { agentName: row.agent_name } : {}),
  ...(row.session_id ? { sessionId: row.session_id } : {}),
});

export async function followupSummaries(
  client: Client,
  owner: string,
  ids: string[],
) {
  const summaries = new Map<string, FollowupSummary>(
    ids.map((id) => [id, emptyFollowupSummary()]),
  );
  if (!ids.length) return summaries;
  // Append-only, contiguous sequences make the last sequence the exact count.
  const { rows } = await client.query<Row & { file_name: string | null }>(
    `SELECT f.*, a.file_name FROM (
       SELECT DISTINCT ON (record_id) * FROM record_followups
       WHERE owner_id=$1 AND record_id=ANY($2::uuid[]) ORDER BY record_id,sequence DESC
     ) f LEFT JOIN followup_attachments fa ON fa.owner_id=f.owner_id AND fa.followup_id=f.id AND fa.position=0
     LEFT JOIN attachments a ON a.owner_id=fa.owner_id AND a.id=fa.attachment_id`,
    [owner, ids],
  );
  for (const row of rows)
    summaries.set(row.record_id, {
      count: row.sequence,
      latest: {
        id: row.id,
        sequence: row.sequence,
        createdAt: row.created_at.toISOString(),
        source: source(row),
        excerpt: [...(row.body.trim() ? row.body : (row.file_name ?? "附件"))]
          .slice(0, 120)
          .join(""),
      },
    });
  return summaries;
}

export async function followupRows(
  client: Client,
  owner: string,
  record: string,
  limit: number,
  before?: number,
): Promise<SuijiFollowup[]> {
  const { rows } = await client.query<Row>(
    "SELECT * FROM record_followups WHERE owner_id=$1 AND record_id=$2 AND ($3::int IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4",
    [owner, record, before ?? null, limit],
  );
  if (!rows.length) return [];
  const files = await client.query<SuijiAttachment & { followup_id: string }>(
    `SELECT fa.followup_id, a.id,a.kind,a.file_name AS "fileName",a.mime_type AS "mimeType",a.byte_size AS "byteSize",fa.position
     FROM followup_attachments fa JOIN attachments a ON a.owner_id=fa.owner_id AND a.id=fa.attachment_id
     WHERE fa.owner_id=$1 AND fa.followup_id=ANY($2::uuid[]) ORDER BY fa.position`,
    [owner, rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    id: row.id,
    recordId: row.record_id,
    sequence: row.sequence,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    source: source(row),
    attachments: files.rows
      .filter((file) => file.followup_id === row.id)
      .map((file) => ({
        id: file.id,
        kind: file.kind,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        position: file.position,
      })),
  }));
}
