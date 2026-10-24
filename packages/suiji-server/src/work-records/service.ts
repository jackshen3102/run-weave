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
  WorkDay,
  ImportWorkFacts,
} from "@runweave/shared/suiji";
import { transaction } from "../db/pool";
import { mutate, type Mutation } from "../records/mutations";
import { invalid } from "../errors";
import * as repo from "./repository";
import * as schema from "./schema";
import { importFacts } from "./imports";

const cursorSchema = z
  .object({
    v: z.literal(1),
    server: z.string().uuid(),
    owner: z.string().uuid(),
    from: schema.workDate.nullable(),
    to: schema.workDate.nullable(),
    revision: z.string().regex(/^\d+$/),
    date: schema.workDate,
    created: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();
export class WorkRecordService {
  constructor(private pool: pg.Pool) {}
  async get(owner: string, id: string) {
    return repo.fact(await repo.get(this.pool, owner, id));
  }
  async list(
    owner: string,
    raw: z.input<typeof schema.workList>,
  ): Promise<WorkFactPage> {
    const input = schema.workList.parse(raw);
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
          cursor.to !== (input.to ?? null)
        )
          throw invalid("游标不属于当前服务、账户或日期范围");
        if (cursor.revision !== head.revision) repo.changed(head.revision);
        const anchor = await client.query(
          "SELECT 1 FROM work_facts WHERE owner_id=$1 AND id=$2 AND work_date=$3::date AND created_at=$4::timestamptz",
          [owner, cursor.id, cursor.date, cursor.created],
        );
        if (!anchor.rowCount) throw invalid("游标位置无效");
      }
      const rows = (
        await client.query<repo.WorkRow>(
          `SELECT ${repo.columns} FROM work_facts w WHERE owner_id=$1 AND ($2::date IS NULL OR work_date >= $2) AND ($3::date IS NULL OR work_date <= $3)
        AND ($4::date IS NULL OR (work_date,created_at,id)<($4::date,$5::timestamptz,$6::uuid)) ORDER BY w.work_date DESC,w.created_at DESC,w.id DESC LIMIT $7`,
          [
            owner,
            input.from ?? null,
            input.to ?? null,
            cursor?.date ?? null,
            cursor?.created ?? null,
            cursor?.id ?? null,
            input.limit + 1,
          ],
        )
      ).rows;
      const items = rows.slice(0, input.limit).map(repo.fact),
        last = items.at(-1);
      // Counts cover the whole day, including facts on subsequent pages. Covered
      // empty dates are included only for an explicitly selected empty range.
      const days = (
        await client.query<WorkDay>(
          `WITH counts AS (SELECT work_date,count(*)::int AS count FROM work_facts WHERE owner_id=$1 GROUP BY work_date), coverage AS (
        SELECT work_date,CASE WHEN bool_and(status='complete') THEN 'complete' ELSE 'partial' END AS coverage FROM work_day_coverage WHERE owner_id=$1 GROUP BY work_date
      ) SELECT coalesce(c.work_date,v.work_date)::text AS date,coalesce(c.count,0)::int AS count,coalesce(v.coverage,'unknown') AS coverage FROM counts c FULL JOIN coverage v USING(work_date)
        WHERE ($2::date IS NULL OR coalesce(c.work_date,v.work_date)>=$2) AND ($3::date IS NULL OR coalesce(c.work_date,v.work_date)<=$3)
        AND (coalesce(c.work_date,v.work_date)=ANY($4::date[]) OR ($5 AND $6)) ORDER BY date DESC`,
          [
            owner,
            input.from ?? null,
            input.to ?? null,
            [...new Set(items.map((i) => i.workDate))],
            items.length === 0,
            Boolean(input.from || input.to),
          ],
        )
      ).rows;
      return {
        items,
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
                  date: last.workDate,
                  created: last.createdAt,
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      };
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
  import(ctx: Mutation, raw: ImportWorkFacts) {
    const input = schema.workImport.parse(raw);
    return mutate(this.pool, ctx, "work:import", input, (client) =>
      importFacts(client, ctx, input),
    );
  }
}
