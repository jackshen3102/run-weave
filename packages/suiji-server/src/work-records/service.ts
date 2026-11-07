import { assertWorkImport } from "./isolation";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type {
  WorkFactInput,
  WorkFactEdit,
  WorkField,
  WorkReclassification,
  WorkProjectRestore,
  WorkFactPage,
  ImportWorkFacts,
} from "@runweave/shared/suiji";
import { transaction } from "../db/pool";
import { digest, mutate, type Mutation } from "../records/mutations";
import { invalid } from "../errors";
import * as repo from "./repository";
import * as schema from "./schema";
import { importFacts } from "./imports";
import { coverageDays, listSources, sourceRange } from "./sources";
import { WorkReportService, report, reportColumns } from "../work-reports/service";

const cursorSchema = z
  .object({
    v: z.literal(1),
    server: z.string().uuid(),
    owner: z.string().uuid(),
    from: schema.workDate.nullable(),
    to: schema.workDate.nullable(),
    view: z.enum(["all", "logs", "reports"]).optional(),
    includeReviewReports: z.boolean().optional(),
    revision: z.string().regex(/^\d+$/),
    date: schema.workDate,
    created: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();
export class WorkRecordService {
  readonly reports: WorkReportService;
  constructor(private pool: pg.Pool) { this.reports = new WorkReportService(pool); }
  async get(owner: string, id: string) {
    return repo.fact(await repo.get(this.pool, owner, id));
  }
  async list(
    owner: string,
    raw: z.input<typeof schema.workList>,
    includeReviewReports = false,
  ): Promise<WorkFactPage> {
    const input = schema.workList.parse(raw);
    const reportsTable = includeReviewReports ? "work_reports" : "eligible_work_reports";
    return transaction(this.pool, async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const head = (
        await client.query<{ server: string; revision: string }>(
          "SELECT server_id::text AS server,coalesce(h.revision,0)::text AS revision FROM server_identity LEFT JOIN work_feed_heads h ON h.owner_id=$1",
          [owner],
        )
      ).rows[0]!;
      let cursor: z.infer<typeof cursorSchema> | undefined;
      if (input.cursor) {
        try {
          cursor = cursorSchema.parse(
            JSON.parse(Buffer.from(input.cursor, "base64url").toString()),
          );
        } catch {
          throw invalid("工作记录游标无效");
        }
        if (
          cursor.server !== head.server ||
          cursor.owner !== owner ||
          cursor.from !== (input.from ?? null) ||
          cursor.to !== (input.to ?? null) || (cursor.view ?? "all") !== input.view || (cursor.includeReviewReports ?? false) !== includeReviewReports
        )
          throw invalid("游标不属于当前服务、账户或日期范围");
        if (cursor.revision !== head.revision) repo.changed(head.revision);
        const anchor = await client.query(
          `SELECT 1 FROM eligible_work_facts WHERE owner_id=$1 AND id=$2 AND work_date=$3::date AND created_at=$4::timestamptz UNION ALL SELECT 1 FROM ${reportsTable} WHERE owner_id=$1 AND id=$2 AND period_to=$3::date AND created_at=$4::timestamptz`,
          [owner, cursor.id, cursor.date, cursor.created],
        );
        if (!anchor.rowCount) throw invalid("游标位置无效");
      }
      const rows = (
        await client.query<{ id: string; date: string; created: Date; kind: string }>(
          `WITH feed AS (
            SELECT id,work_date AS day,created_at AS created,'fact' AS kind FROM eligible_work_facts WHERE owner_id=$1
            UNION ALL SELECT id,period_to AS day,created_at AS created,'report' AS kind FROM ${reportsTable} WHERE owner_id=$1
          ) SELECT id,day::text AS date,created,kind FROM feed
          WHERE ($8 = 'all' OR ($8 = 'logs' AND kind='fact') OR ($8 = 'reports' AND kind='report')) AND ($2::date IS NULL OR day >= $2) AND ($3::date IS NULL OR day <= $3)
          AND ($4::date IS NULL OR (day,created,id)<($4::date,$5::timestamptz,$6::uuid)) ORDER BY day DESC,created DESC,id DESC LIMIT $7`,
          [
            owner,
            input.from ?? null,
            input.to ?? null,
            cursor?.date ?? null,
            cursor?.created ?? null,
            cursor?.id ?? null,
            input.limit + 1,
            input.view,
          ],
        )
      ).rows;
      const selected = rows.slice(0, input.limit), last = selected.at(-1);
      const factRows = (await client.query<repo.WorkRow>(`SELECT ${repo.columns} FROM eligible_work_facts WHERE owner_id=$1 AND id=ANY($2::uuid[])`, [owner, selected.filter(r => r.kind === "fact").map(r => r.id)])).rows;
      const items = selected.flatMap(r => factRows.filter(f => f.id === r.id).map(repo.fact));
      const reportRows = (await client.query<Parameters<typeof report>[0]>(`SELECT ${reportColumns} FROM ${reportsTable} WHERE owner_id=$1 AND id=ANY($2::uuid[])`, [owner, selected.filter(r => r.kind === "report").map(r => r.id)])).rows;
      const reports = selected.flatMap(r => reportRows.filter(f => f.id === r.id).map(report));
      const dates = new Set(selected.map(i => i.date));
      if (input.from && input.to) {
        sourceRange.parse({ from: input.from, to: input.to });
        for (let t = Date.parse(input.from); t <= Date.parse(input.to); t += 86400000)
          dates.add(new Date(t).toISOString().slice(0,10));
      }
      const days = await coverageDays(client, owner, [...dates]);
      return {
        items,
        reports,
        days,
        feedRevision: head.revision,
        nextCursor:
          rows.length > input.limit && last
            ? Buffer.from(
                JSON.stringify({
                  v: 1,
                  server: head.server,
                  owner,
                  from: input.from ?? null,
                  to: input.to ?? null,
                  revision: head.revision,
                  view: input.view,
                  includeReviewReports,
                  date: last.date,
                  created: last.created.toISOString(),
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }
  sources(owner: string, raw: unknown) {
    return transaction(this.pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return listSources(client, owner, raw);
    });
  }
  create(ctx: Mutation, raw: WorkFactInput) {
    const input = schema.workCreate.parse(raw);
    return mutate(this.pool, ctx, "work:create", input, async (client) => {
      await repo.lockHead(client, ctx.ownerId);
      const row = (
        await client.query<repo.WorkRow>(
          `INSERT INTO work_facts(id,owner_id,event_key,work_date,title,statement,status,project,created_via,manual_fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${repo.columns}`,
          [
            randomUUID(),
            ctx.ownerId,
            `manual:${randomUUID()}`,
            input.workDate,
            input.title,
            input.statement,
            input.status,
            input.project,
            ctx.actor,
            JSON.stringify(Object.keys(schema.workFields)),
          ],
        )
      ).rows[0]!;
      await repo.revision(client, ctx, row);
      await repo.bump(client, ctx.ownerId);
      return { fact: repo.fact(row) };
    });
  }
  edit(ctx: Mutation, id: string, raw: WorkFactEdit) {
    const input = schema.workEdit.parse(raw);
    return mutate(
      this.pool,
      ctx,
      "work:edit",
      { id, ...input },
      async (client) => {
        await repo.lockHead(client, ctx.ownerId);
        const row = await repo.get(client, ctx.ownerId, id, true);
        repo.checkVersion(row, input.expectedVersion);
        const old = repo.fact(row),
          fields = (Object.keys(input) as WorkField[]).filter(
            (k) => k !== ("expectedVersion" as WorkField),
          );
        const value = { ...old, ...input },
          manual = [...new Set([...row.manual_fields, ...fields])];
        const updated = (
          await client.query<repo.WorkRow>(
            `UPDATE work_facts SET work_date=$3,title=$4,statement=$5,status=$6,project=$7,manual_fields=$8,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING ${repo.columns}`,
            [
              ctx.ownerId,
              id,
              value.workDate,
              value.title,
              value.statement,
              value.status,
              value.project,
              JSON.stringify(manual),
            ],
          )
        ).rows[0]!;
        await repo.revision(client, ctx, updated);
        await repo.bump(client, ctx.ownerId);
        return { fact: repo.fact(updated) };
      },
    );
  }
  reclassify(ctx: Mutation, raw: WorkReclassification) {
    const input = schema.reclassify.parse(raw);
    return this.changeProjects(
      ctx,
      input.items.map((i) => ({ ...i, project: input.project })),
      "work:reclassify",
      input,
    );
  }
  restoreProjects(ctx: Mutation, raw: WorkProjectRestore) {
    const input = schema.restoreProjects.parse(raw);
    return this.changeProjects(
      ctx,
      input.items,
      "work:restore-projects",
      input,
    );
  }
  private changeProjects(
    ctx: Mutation,
    items: WorkProjectRestore["items"],
    operation: string,
    input: unknown,
  ) {
    return mutate(this.pool, ctx, operation, input, async (client) => {
      await repo.lockHead(client, ctx.ownerId);
      const rows: repo.WorkRow[] = [];
      for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
        const row = await repo.get(client, ctx.ownerId, item.id, true);
        repo.checkVersion(row, item.expectedVersion);
        rows.push(row);
      }
      const facts = [];
      for (const row of rows) {
        const manual = [...new Set([...row.manual_fields, "project"])];
        const updated = (
          await client.query<repo.WorkRow>(
            `UPDATE work_facts SET project=$3,manual_fields=$4,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING ${repo.columns}`,
            [
              ctx.ownerId,
              row.id,
              items.find((i) => i.id === row.id)!.project,
              JSON.stringify(manual),
            ],
          )
        ).rows[0]!;
        await repo.revision(client, ctx, updated);
        facts.push(repo.fact(updated));
      }
      await repo.bump(client, ctx.ownerId);
      return { facts };
    });
  }
  async importReceipt(owner: string, key: string, raw: ImportWorkFacts) {
    const input = schema.workImport.parse(raw);
    const hash = digest({ operation: "agent:work:import", input });
    const row = (await this.pool.query("SELECT request_hash,response FROM mutation_requests WHERE owner_id=$1 AND idempotency_key=$2", [owner, key])).rows[0];
    if (!row) return { found: false };
    if (row.request_hash !== hash) throw invalid("原请求身份不匹配");
    return { found: true, importId: row.response?.importId, feedRevision: row.response?.feedRevision };
  }
  import(ctx: Mutation, raw: ImportWorkFacts) {
    assertWorkImport(raw);
    const input = schema.workImport.parse(raw);
    return mutate(this.pool, ctx, "work:import", input, (client) =>
      importFacts(client, ctx, input),
    );
  }
}
