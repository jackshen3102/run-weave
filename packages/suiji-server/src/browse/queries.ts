import type pg from "pg";
import type { z } from "zod";
import type { BrowsePage } from "@runweave/shared/suiji";
import type * as schema from "./schema";
import { digest } from "../records/mutations";
import { invalid } from "../errors";
import { getEntry, head } from "./repository";
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed;
  } catch {
    throw invalid("浏览游标无效");
  }
}
export async function listBrowse(
  c: pg.PoolClient,
  owner: string,
  input: z.infer<typeof schema.browseList>,
): Promise<BrowsePage> {
  const { cursor, limit, ...filters } = input;
  const epoch = (await c.query("SELECT server_id FROM server_identity")).rows[0]
    .server_id;
  const fingerprint = digest({ owner, epoch, filters });
  const values: unknown[] = [owner];
  const where = [
    "owner_id=$1",
    input.trash === "true" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL",
  ];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll("?", `$${values.length}`));
  };
  if (input.source) add("source->>'provider'=?", input.source);
  if (input.type) add("content_type=?", input.type);
  if (input.from) add("browse_date>=?::date", input.from);
  if (input.to) add("browse_date<=?::date", input.to);
  if (input.q)
    add(
      "(concat_ws(' ',title,body,user_note) ILIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM browse_digests d WHERE d.owner_id=browse_entries.owner_id AND d.state='current' AND d.entry_refs @> jsonb_build_array(jsonb_build_object('id',browse_entries.id::text)) AND concat_ws(' ',d.title,d.body) ILIKE ? ESCAPE '\\'))",
      `%${input.q.replace(/[\\%_]/g, "\\$&")}%`,
    );
  const counts = await c.query(
    `SELECT browse_date::text AS date,count(*)::int AS count FROM browse_entries WHERE ${where.join(" AND ")} GROUP BY browse_date ORDER BY browse_date DESC`,
    values,
  );
  if (cursor) {
    const v = decode(cursor);
    if (
      v.f !== fingerprint ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.day) ||
      !Number.isFinite(Date.parse(v.at)) ||
      !/^[a-f0-9-]{36}$/.test(v.id)
    )
      throw invalid("浏览游标与筛选不匹配");
    values.push(v.day, v.at, v.id);
    where.push(
      `(browse_date,coalesce(occurred_at,captured_at),id)<($${values.length - 2}::date,$${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(limit + 1);
  const rows = (
    await c.query(
      `SELECT id FROM browse_entries WHERE ${where.join(" AND ")} ORDER BY browse_date DESC,coalesce(occurred_at,captured_at) DESC,id DESC LIMIT $${values.length}`,
      values,
    )
  ).rows;
  const items = [];
  for (const row of rows.slice(0, limit))
    items.push(await getEntry(c, owner, row.id));
  const last = items.at(-1);
  const sources = (
    await c.query(
      "SELECT DISTINCT ON (source->>'provider') source FROM browse_entries WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY source->>'provider',captured_at DESC",
      [owner],
    )
  ).rows.map((r) => r.source);
  const days = [...new Set(items.map((i) => i.browseDate))];
  const digests =
    input.trash || input.type || input.q
      ? []
      : (
          await c.query(
            `SELECT d.id,d.digest_date::text AS date,d.connection_id AS "connectionId",d.title,d.body,d.version,d.state,d.entry_refs AS "entryRefs",d.input_revision::text AS "inputRevision" FROM browse_digests d JOIN browse_connections b ON b.owner_id=d.owner_id AND b.id=d.connection_id WHERE d.owner_id=$1 AND d.digest_date=ANY($2::date[]) AND ($3::text IS NULL OR b.provider=$3) ORDER BY d.digest_date DESC,d.id`,
            [owner, days, input.source ?? null],
          )
        ).rows;

  return {
    items: items.map(({ body, ...entry }) => ({
      ...entry,
      excerpt: [...body].slice(0, 300).join(""),
      bodyScalars: [...body].length,
    })),
    sources,
    digests,
    dayCounts: counts.rows,
    browseRevision: await head(c, owner),
    nextCursor:
      rows.length > limit && last
        ? encode({
            f: fingerprint,
            day: last.browseDate,
            at: last.occurredAt ?? last.capturedAt,
            id: last.id,
          })
        : null,
  };
}
export async function changes(
  c: pg.PoolClient,
  owner: string,
  input: z.infer<typeof schema.changesInput>,
) {
  const revision = await head(c, owner);
  const epoch = (await c.query("SELECT server_id FROM server_identity")).rows[0]
    .server_id;
  const v = input.cursor
    ? decode(input.cursor)
    : { owner, epoch, after: "0", until: revision };
  const seq = (s: unknown): s is string =>
    typeof s === "string" && /^(0|[1-9][0-9]{0,18})$/.test(s);
  if (
    v.owner !== owner ||
    v.epoch !== epoch ||
    !seq(v.after) ||
    (v.until !== undefined && !seq(v.until))
  )
    throw invalid("浏览变化游标无效");
  const until = v.until ?? revision;
  if (BigInt(v.after) > BigInt(until) || BigInt(until) > BigInt(revision))
    throw invalid("浏览变化游标失效");
  const rows = (
    await c.query(
      `SELECT revision::text,entry_id AS "entryId",digest_id AS "digestId",kind,version,deleted FROM browse_changes WHERE owner_id=$1 AND revision>$2::bigint AND revision<=$3::bigint ORDER BY revision LIMIT $4`,
      [owner, v.after, until, input.limit + 1],
    )
  ).rows;
  const items = rows.slice(0, input.limit),
    hasMore = rows.length > input.limit;
  return {
    items,
    hasMore,
    browseRevision: revision,
    nextCursor: encode({
      owner,
      epoch,
      after: items.at(-1)?.revision ?? until,
      ...(hasMore ? { until } : {}),
    }),
  };
}
