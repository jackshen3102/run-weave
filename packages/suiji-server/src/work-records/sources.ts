import type pg from "pg";
import { z } from "zod";
import type { WorkSource, WorkSourcePage, WorkReceipt } from "@runweave/shared/suiji";
import { transaction } from "../db/pool";
import { invalid } from "../errors";
import * as repo from "./repository";
import { workDate } from "./schema";

const scope = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
export const sourceInput = z.object({
  sourceScope: scope, producerId: scope, sourceNamespace: scope,
  name: z.string().trim().min(1).max(80).regex(/^[^\r\n\t]+$/),
  effectiveFrom: workDate, effectiveTo: workDate.nullable().default(null),
}).strict().refine(v => !v.effectiveTo || v.effectiveTo > v.effectiveFrom, "来源日期区间无效");
export const sourceRange = z.object({ from: workDate, to: workDate }).strict().refine(
  v => v.from <= v.to && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 < 366,
  "日期范围须为1–366天",
);
const columns = `source_scope AS "sourceScope",producer_id AS "producerId",source_namespace AS "sourceNamespace",name,effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo"`;

export async function registerSource(pool: pg.Pool, owner: string, raw: unknown) {
  const input = sourceInput.parse(raw);
  return transaction(pool, async client => {
    await repo.lockHead(client, owner);
    const overlaps = await client.query<WorkSource>(
      `SELECT ${columns} FROM work_sources WHERE owner_id=$1 AND source_scope=$2
       AND effective_from < coalesce($4::date,'infinity'::date) AND coalesce(effective_to,'infinity'::date)>$3::date`,
      [owner,input.sourceScope,input.effectiveFrom,input.effectiveTo],
    );
    if (overlaps.rows.length) {
      if (overlaps.rows.length === 1 && Object.entries(input).every(([k,v]) => overlaps.rows[0]![k as keyof WorkSource] === v)) return input;
      throw invalid("来源有效区间重叠，不能重复登记或转移飞书采集归属");
    }
    await client.query(`INSERT INTO work_sources(owner_id,source_scope,producer_id,source_namespace,name,effective_from,effective_to) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [owner,input.sourceScope,input.producerId,input.sourceNamespace,input.name,input.effectiveFrom,input.effectiveTo]);
    await repo.bump(client, owner);
    return input;
  });
}

export async function stopSource(pool: pg.Pool, owner: string, raw: unknown) {
  const input = z.object({ sourceScope: scope, effectiveTo: workDate }).strict().parse(raw);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  if (input.effectiveTo < today) throw invalid("停用不能追溯消除历史缺报");
  return transaction(pool, async client => {
    await repo.lockHead(client, owner);
    const updated = await client.query(`UPDATE work_sources SET effective_to=$3::date WHERE owner_id=$1 AND source_scope=$2 AND effective_from<$3::date AND (effective_to IS NULL OR effective_to>$3::date) RETURNING ${columns}`, [owner,input.sourceScope,input.effectiveTo]);
    if (updated.rowCount) await repo.bump(client, owner);
    return { items: updated.rows };
  });
}

export async function listSources(client: pg.PoolClient, owner: string, raw: unknown): Promise<WorkSourcePage> {
  const range = sourceRange.parse(raw);
  const items = (await client.query<WorkSource>(`SELECT ${columns} FROM work_sources WHERE owner_id=$1 AND effective_from<=$3::date AND (effective_to IS NULL OR effective_to>$2::date) ORDER BY source_scope,effective_from`, [owner,range.from,range.to])).rows;
  const receipts = (await client.query<WorkReceipt & { date: string }>(`SELECT work_date::text AS date,source_scope AS "sourceScope",status,collected_at AS "collectedAt",window_from AS "from",window_to AS "to" FROM work_day_coverage WHERE owner_id=$1 AND work_date BETWEEN $2::date AND $3::date`, [owner,range.from,range.to])).rows;
  const days: WorkSourcePage["days"] = [];
  for (let t = Date.parse(range.from); t <= Date.parse(range.to); t += 86400000) {
    const date = new Date(t).toISOString().slice(0,10);
    const actual = receipts.filter(r => r.date === date).map(r => ({ sourceScope: r.sourceScope, status: r.status, collectedAt: r.collectedAt, from: r.from, to: r.to }));
    const expected = items.filter(s => s.effectiveFrom <= date && (!s.effectiveTo || s.effectiveTo > date));
    days.push({ date, receipts: actual, missingScopes: expected.filter(s => !actual.some(r => r.sourceScope === s.sourceScope)).map(s => s.sourceScope) });
  }
  return { items, days };
}

/** Dates come from one list page, plus an explicitly bounded requested range. */
export async function coverageDays(client: pg.PoolClient, owner: string, dates: string[]) {
  return (await client.query(`WITH dates AS (SELECT unnest($2::date[]) AS day)
    SELECT d.day::text AS date,(SELECT count(*)::int FROM work_facts f WHERE f.owner_id=$1 AND f.work_date=d.day) AS count,
    CASE WHEN count(s.source_scope)=0 THEN 'unknown'
         WHEN bool_and(coalesce(c.status='complete',false)) THEN 'complete' ELSE 'partial' END AS coverage
    FROM dates d LEFT JOIN work_sources s ON s.owner_id=$1 AND s.effective_from<=d.day AND (s.effective_to IS NULL OR s.effective_to>d.day)
    LEFT JOIN work_day_coverage c ON c.owner_id=$1 AND c.work_date=d.day AND c.source_scope=s.source_scope
    GROUP BY d.day ORDER BY d.day DESC`, [owner,dates])).rows;
}
