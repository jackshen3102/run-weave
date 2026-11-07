import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { WorkReport, WorkReportInput, WorkReportEdit } from "@runweave/shared/suiji";
import { mutate, type Mutation } from "../records/mutations";
import { missing, ServiceError } from "../errors";
import { lockHead, bump, changed } from "../work-records/repository";
import { coverageDays } from "../work-records/sources";
import * as schema from "./schema";

export const reportColumns = `id,period_from::text AS "from",period_to::text AS "to",title,body,
 based_on_feed_revision AS "basedOnFeedRevision",source_facts AS "sourceFacts",days,version,
 needs_review AS "needsReview",manually_edited AS "manuallyEdited",created_at AS "createdAt",updated_at AS "updatedAt"`;
type Row = Omit<WorkReport, "kind" | "timeZone" | "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
export function report(row: Row): WorkReport {
  return { ...row, kind: "weekly", timeZone: "Asia/Shanghai", createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export class WorkReportService {
  constructor(private pool: pg.Pool) {}
  async get(owner: string, id: string, includeReview = false) {
    const row = (await this.pool.query<Row>(`SELECT ${reportColumns} FROM work_reports WHERE owner_id=$1 AND id=$2 ${includeReview ? "" : "AND NOT needs_review"}`, [owner, id])).rows[0];
    if (!row) throw missing();
    return report(row);
  }
  async find(owner: string, raw: unknown) {
    const p = schema.period.parse(raw);
    const row = (await this.pool.query<Row>(`SELECT ${reportColumns} FROM eligible_work_reports WHERE owner_id=$1 AND period_from=$2 AND period_to=$3`, [owner, p.from, p.to])).rows[0];
    return row ? report(row) : null;
  }
  private async revision(client: pg.PoolClient, ctx: Mutation, value: WorkReport) {
    await client.query("INSERT INTO work_report_revisions(owner_id,report_id,version,snapshot,actor,request_id) VALUES($1,$2,$3,$4,$5,$6)",
      [ctx.ownerId, value.id, value.version, JSON.stringify(value), ctx.actor, ctx.requestId]);
    await bump(client, ctx.ownerId);
    return { report: value };
  }
  publish(ctx: Mutation, raw: WorkReportInput) {
    const input = schema.publish.parse(raw);
    return mutate(this.pool, ctx, "work-report:publish", input, async client => {
      const head = await lockHead(client, ctx.ownerId);
      const old = (await client.query<Row>(`SELECT ${reportColumns} FROM work_reports WHERE owner_id=$1 AND period_from=$2 AND period_to=$3 FOR UPDATE`, [ctx.ownerId, input.from, input.to])).rows[0];
      if (old && !old.needsReview && old.basedOnFeedRevision === input.basedOnFeedRevision && old.title === input.title && old.body === input.body && JSON.stringify(old.sourceFacts) === JSON.stringify(input.sourceFacts)) return { report: report(old) };
      if (old?.manuallyEdited) throw new ServiceError(409, "REPORT_MANUALLY_EDITED", "周报已有人工编辑，自动生成不得覆盖");
      if ((old?.version ?? undefined) !== input.expectedVersion) throw new ServiceError(409, "VERSION_CONFLICT", "周报版本已变化，请重新读取核对");
      if (head !== input.basedOnFeedRevision) changed(head);
      const facts = (await client.query<{ id: string; version: number }>("SELECT id,version FROM eligible_work_facts WHERE owner_id=$1 AND work_date BETWEEN $2::date AND $3::date ORDER BY id", [ctx.ownerId, input.from, input.to])).rows;
      const refs = [...input.sourceFacts].sort((a,b) => a.id.localeCompare(b.id));
      if (JSON.stringify(facts) !== JSON.stringify(refs)) throw new ServiceError(409, "REPORT_SOURCES_CHANGED", "周报来源必须包含该周期全部当前事实及版本");
      const dates = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(input.from) + i * 86400000).toISOString().slice(0,10));
      const days = await coverageDays(client, ctx.ownerId, dates);
      const value = old
        ? (await client.query<Row>(`UPDATE work_reports SET title=$3,body=$4,needs_review=false,based_on_feed_revision=$5,source_facts=$6,days=$7,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING ${reportColumns}`, [ctx.ownerId, old.id, input.title, input.body, head, JSON.stringify(input.sourceFacts), JSON.stringify(days)])).rows[0]!
        : (await client.query<Row>(`INSERT INTO work_reports(id,owner_id,period_from,period_to,title,body,based_on_feed_revision,source_facts,days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${reportColumns}`, [randomUUID(), ctx.ownerId, input.from, input.to, input.title, input.body, head, JSON.stringify(input.sourceFacts), JSON.stringify(days)])).rows[0]!;
      return this.revision(client, ctx, report(value));
    });
  }
  edit(ctx: Mutation, id: string, raw: WorkReportEdit) {
    const input = schema.edit.parse(raw);
    return mutate(this.pool, ctx, "work-report:edit", { id, ...input }, async client => {
      await lockHead(client, ctx.ownerId);
      const row = (await client.query<Row>(`SELECT ${reportColumns} FROM work_reports WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [ctx.ownerId, id])).rows[0];
      if (!row) throw missing();
      if (row.version !== input.expectedVersion) throw new ServiceError(409, "VERSION_CONFLICT", "周报已更新，请重新读取并核对草稿");
      const value = (await client.query<Row>(`UPDATE work_reports SET title=$3,body=$4,manually_edited=true,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING ${reportColumns}`, [ctx.ownerId, id, input.title, input.body])).rows[0]!;
      return this.revision(client, ctx, report(value));
    });
  }
}
