import type pg from "pg";
import { ServiceError } from "../errors";
type Client = Pick<pg.Pool, "query">;
export async function browseEnabled(c: Client, owner: string) {
  return Boolean(
    (await c.query("SELECT 1 FROM browse_cutovers WHERE owner_id=$1", [owner]))
      .rowCount,
  );
}
export async function assertRecordDomain(c: Client, owner: string, id: string) {
  const row = (
    await c.query(
      "SELECT migrated_browse_id FROM records WHERE owner_id=$1 AND id=$2",
      [owner, id],
    )
  ).rows[0];
  if (row?.migrated_browse_id)
    throw new ServiceError(
      409,
      "RECORD_MOVED_TO_BROWSE",
      "已迁入浏览，需要新版客户端",
      { browseEntryId: row.migrated_browse_id },
    );
}
