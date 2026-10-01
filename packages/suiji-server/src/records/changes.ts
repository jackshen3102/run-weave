import type pg from "pg";
import type { SuijiChange, SuijiChangePage } from "@runweave/shared/suiji";
import { transaction } from "../db/pool";
import { invalid } from "../errors";

type Cursor = {
  v: 1;
  owner: string;
  epoch: string;
  after: string;
  until?: string;
};
const sequence = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value);

export async function listChanges(
  pool: pg.Pool,
  owner: string,
  input: { cursor?: string; limit: number },
): Promise<SuijiChangePage> {
  let cursor: Cursor | undefined;
  if (input.cursor) {
    try {
      cursor = JSON.parse(
        Buffer.from(input.cursor, "base64url").toString("utf8"),
      );
      if (
        !cursor ||
        cursor.v !== 1 ||
        cursor.owner !== owner ||
        typeof cursor.epoch !== "string" ||
        !sequence(cursor.after) ||
        (cursor.until !== undefined &&
          (!sequence(cursor.until) ||
            BigInt(cursor.until) < BigInt(cursor.after)))
      )
        throw new Error();
    } catch {
      throw invalid("变化游标无效；请清空本地索引并从无游标重新同步");
    }
  }
  return transaction(pool, async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    // The server identity binds cursors even for an empty owner.
    const head = (
      await client.query<{ epoch: string; sequence: string }>(
        `SELECT s.server_id::text AS epoch, coalesce(h.sequence,0)::text AS sequence
       FROM server_identity s LEFT JOIN record_change_heads h ON h.owner_id=$1`,
        [owner],
      )
    ).rows[0]!;
    if (
      cursor &&
      (cursor.epoch !== head.epoch ||
        BigInt(cursor.after) > BigInt(head.sequence) ||
        (cursor.until !== undefined &&
          BigInt(cursor.until) > BigInt(head.sequence)))
    )
      throw invalid("变化游标已失效；请清空本地索引并从无游标重新同步");
    const after = cursor?.after ?? "0";
    const until = cursor?.until ?? head.sequence;
    const rows = await client.query<SuijiChange>(
      `SELECT c.sequence::text, c.record_id AS "recordId", c.kind, c.actor,
       c.record_version AS "recordVersion", c.followup_id AS "followupId",
       c.followup_sequence AS "followupSequence", c.deleted,
       (r.deleted_at IS NOT NULL) AS "currentlyDeleted"
       FROM record_changes c JOIN records r ON r.owner_id=c.owner_id AND r.id=c.record_id
       WHERE c.owner_id=$1 AND c.sequence>$2::bigint AND c.sequence<=$3::bigint
       ORDER BY c.sequence LIMIT $4`,
      [owner, after, until, input.limit + 1],
    );
    const items = rows.rows.slice(0, input.limit);
    const hasMore = rows.rows.length > input.limit;
    const next: Cursor = {
      v: 1,
      owner,
      epoch: head.epoch,
      after: items.at(-1)?.sequence ?? after,
      ...(hasMore ? { until } : {}),
    };
    return {
      items,
      hasMore,
      nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url"),
    };
  });
}
