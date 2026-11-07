import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { BrowseImport, BrowseRun } from "@runweave/shared/suiji";
import { digest } from "../records/mutations";
import { invalid, missing, ServiceError } from "../errors";
import * as repo from "./repository";
export async function getRun(
  c: Pick<pg.Pool, "query">,
  owner: string,
  id: string,
): Promise<BrowseRun> {
  const row = (
    await c.query(
      `SELECT run_id AS "runId",connection_id AS "connectionId",from_date::text AS "from",to_date::text AS "to",coverage,receipt FROM browse_runs WHERE owner_id=$1 AND run_id=$2`,
      [owner, id],
    )
  ).rows[0];
  if (!row) throw missing();
  return row;
}
export async function importEntries(
  c: pg.PoolClient,
  owner: string,
  input: BrowseImport,
): Promise<BrowseRun> {
  await repo.lockHead(c, owner);
  const hash = digest(input);
  const old = (
    await c.query(
      "SELECT request_hash FROM browse_runs WHERE owner_id=$1 AND run_id=$2",
      [owner, input.runId],
    )
  ).rows[0];
  if (old) {
    if (old.request_hash !== hash)
      throw new ServiceError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "runId 已用于其他批次",
      );
    return getRun(c, owner, input.runId);
  }
  const connection = (
    await c.query(
      "SELECT * FROM browse_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE",
      [owner, input.connectionId],
    )
  ).rows[0];
  if (
    !connection ||
    connection.state !== "active" ||
    connection.external_account_id !== input.externalAccountId ||
    input.identityBefore !== input.externalAccountId ||
    input.identityAfter !== input.externalAccountId
  )
    throw invalid("连接或账号身份不匹配");
  const receipt = { created: 0, updated: 0, unchanged: 0, browseRevision: "0" };
  await c.query("INSERT INTO browse_runs(owner_id,run_id,connection_id,request_hash,from_date,to_date,coverage,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [
    owner,
    input.runId,
    input.connectionId,
    hash,
    input.from,
    input.to,
    JSON.stringify(input.coverage),
    JSON.stringify(receipt),
  ]);
  for (const { observation: o, entry } of input.items) {
    const day = new Date(Date.parse(o.readTime) + 8 * 3600000)
      .toISOString()
      .slice(0, 10);
    if (
      day !== entry.browseDate ||
      day < input.from ||
      day > input.to ||
      entry.source.connectionId !== input.connectionId ||
      entry.source.provider !== connection.provider ||
      entry.captureMethod !== "connector" ||
      entry.attachmentIds.length
    )
      throw invalid("导入日期、来源或采集方式不匹配");
    let row = (
      await c.query(
        "SELECT id,deleted_at,content_hash,occurred_at FROM browse_entries WHERE owner_id=$1 AND connection_id=$2 AND external_content_type=$3 AND external_content_id=$4 AND browse_date=$5",
        [owner, input.connectionId, o.contentType, o.contentId, day],
      )
    ).rows[0];
    if (!row) {
      row = { id: randomUUID() };
      await repo.insertEntry(
        c,
        owner,
        row.id,
        { ...entry, occurredAt: o.readTime },
        {
          connectionId: input.connectionId,
          type: o.contentType,
          id: o.contentId,
        },
      );
      await repo.snapshot(c, owner, row.id);
      receipt.created++;
    } else if (row.deleted_at) receipt.unchanged++;
    else if (
      row.content_hash !== repo.contentHash(entry) ||
      !row.occurred_at ||
      Date.parse(o.readTime) > row.occurred_at.valueOf()
    ) {
      // Connector refreshes original content only; user notes stay untouched.
      await c.query(
        `UPDATE browse_entries SET title=$3,body=$4,source_url=$5,content_state=$6,content_hash=$7,occurred_at=greatest(occurred_at,$8::timestamptz),version=version+1 WHERE owner_id=$1 AND id=$2`,
        [
          owner,
          row.id,
          entry.title,
          entry.body,
          entry.sourceUrl,
          JSON.stringify(entry.contentState),
          repo.contentHash(entry),
          o.readTime,
        ],
      );
      await repo.snapshot(c, owner, row.id);
      receipt.updated++;
    } else receipt.unchanged++;
    await c.query(
      "INSERT INTO browse_observations VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
      [
        owner,
        input.runId,
        row.id,
        o.contentType,
        o.contentId,
        o.readTime,
        o.observedAt,
      ],
    );
  }
  receipt.browseRevision = await repo.head(c, owner);
  await c.query(
    "UPDATE browse_runs SET receipt=$3 WHERE owner_id=$1 AND run_id=$2",
    [owner, input.runId, JSON.stringify(receipt)],
  );
  if (input.coverage.state === "complete")
    await c.query(
      "UPDATE browse_connections SET last_success_at=clock_timestamp() WHERE owner_id=$1 AND id=$2",
      [owner, input.connectionId],
    );
  return getRun(c, owner, input.runId);
}
