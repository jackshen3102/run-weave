import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  CreateRecord,
  EditRecord,
  ChangeTaskStatus,
  ChangeRecordTrash,
  SuijiRecord,
  RecordPage,
} from "@runweave/shared/suiji";
import { SUIJI_LIMITS } from "@runweave/shared/suiji";
import { invalid, missing, ServiceError } from "../errors";
import { transaction } from "../db/pool";
import { digest, mutate, type Mutation } from "./mutations";
import { getRecord } from "./repository";
export type RecordQuery = {
  trash?: "true";
  kind?: string;
  taskStatus?: string;
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};
export class RecordService {
  constructor(private pool: pg.Pool) {}
  // A repeatable-read snapshot prevents a body/version from being paired with newer attachments.
  async get(owner: string, id: string, includeTrash = false) {
    return transaction(this.pool, async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return getRecord(client, owner, id, false, includeTrash);
    });
  }
  async list(owner: string, query: RecordQuery): Promise<RecordPage> {
    const { cursor, limit, ...filters } = query;
    const fingerprint = digest(filters);
    const values: unknown[] = [owner];
    const where = [
      "owner_id=$1",
      query.trash === "true" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL",
    ];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      where.push(sql.replace("?", `$${values.length}`));
    };
    if (query.kind) add("kind=?", query.kind);
    if (query.taskStatus) add("task_status=?", query.taskStatus);
    if (query.q)
      add("body LIKE ? ESCAPE '\\'", `%${query.q.replace(/[\\%_]/g, "\\$&")}%`);
    if (query.from) add("created_at>=?", query.from);
    if (query.to) add("created_at<?", query.to);
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
          c.f !== fingerprint ||
          !/^[0-9a-f-]{36}$/.test(c.id) ||
          !Number.isFinite(Date.parse(c.at))
        )
          throw new Error();
        values.push(c.at, c.id);
        where.push(`(created_at,id)<($${values.length - 1},$${values.length})`);
      } catch {
        throw invalid("游标与当前筛选不匹配");
      }
    }
    values.push(limit + 1);
    return transaction(this.pool, async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const rows = (
        await client.query(
          `SELECT id FROM records WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`,
          values,
        )
      ).rows;
      const items: SuijiRecord[] = [];
      for (const row of rows.slice(0, limit))
        items.push(
          await getRecord(client, owner, row.id, false, query.trash === "true"),
        );
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  f: fingerprint,
                  at: last.createdAt,
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }
  create(context: Mutation, input: CreateRecord) {
    return mutate(
      this.pool,
      context,
      "create",
      { ...input, attachmentIds: input.attachmentIds ?? [] },
      async (client) => {
        const id = randomUUID();
        this.checkContent(input.body, input.attachmentIds ?? []);
        await client.query(
          "INSERT INTO records(id,owner_id,kind,body,task_status,created_via) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            context.ownerId,
            input.kind,
            input.body,
            input.kind === "task" ? "open" : null,
            context.actor,
          ],
        );
        await this.attach(
          client,
          context.ownerId,
          id,
          input.attachmentIds ?? [],
        );
        return this.snapshot(client, context, id);
      },
    );
  }
  edit(context: Mutation, id: string, input: EditRecord) {
    return mutate(this.pool, context, `edit:${id}`, input, async (client) => {
      const old = await getRecord(client, context.ownerId, id, true);
      this.version(old, input.expectedVersion);
      const body = input.body ?? old.body,
        ids = input.attachmentIds ?? old.attachments.map((a) => a.id);
      this.checkContent(body, ids);
      if (
        body === old.body &&
        JSON.stringify(ids) === JSON.stringify(old.attachments.map((a) => a.id))
      )
        return { record: old };
      await this.attach(client, context.ownerId, id, ids);
      await client.query(
        "UPDATE records SET body=$3,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2",
        [context.ownerId, id, body],
      );
      return this.snapshot(client, context, id);
    });
  }
  status(context: Mutation, id: string, input: ChangeTaskStatus) {
    return mutate(this.pool, context, `status:${id}`, input, async (client) => {
      const old = await getRecord(client, context.ownerId, id, true);
      this.version(old, input.expectedVersion);
      const allowed =
        (old.taskStatus === "open" &&
          (input.targetStatus === "done" ||
            input.targetStatus === "archived")) ||
        (old.taskStatus === "done" && input.targetStatus === "open");
      if (old.kind !== "task" || !allowed)
        throw new ServiceError(
          409,
          "INVALID_TRANSITION",
          "仅支持完成或放弃未完成待办，以及将已完成待办恢复为未完成",
        );
      await client.query(
        "UPDATE records SET task_status=$3,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2",
        [context.ownerId, id, input.targetStatus],
      );
      return this.snapshot(client, context, id);
    });
  }
  trash(context: Mutation, id: string, input: ChangeRecordTrash) {
    return mutate(this.pool, context, `trash:${id}`, input, async (client) => {
      const old = await getRecord(client, context.ownerId, id, true, true);
      this.version(old, input.expectedVersion);
      if (Boolean(old.deletedAt) === input.trashed) return { record: old };
      await client.query(
        "UPDATE records SET deleted_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2",
        [context.ownerId, id, input.trashed],
      );
      return this.snapshot(client, context, id, true);
    });
  }
  private version(record: SuijiRecord, expected: number) {
    if (record.version !== expected)
      throw new ServiceError(
        409,
        "VERSION_CONFLICT",
        "记录已有新版本，请比较后继续编辑",
        { currentVersion: record.version },
      );
  }
  private checkContent(body: string, ids: string[]) {
    if (!body.trim() && !ids.length) throw invalid("请输入正文或添加附件");
  }
  private async attach(
    client: pg.PoolClient,
    owner: string,
    id: string,
    ids: string[],
  ) {
    if (new Set(ids).size !== ids.length) throw invalid("附件不能重复");
    // Deterministic lock order also covers competing attempts to first-bind an upload.
    const rows = (
      await client.query(
        "SELECT id,kind,bound_record_id FROM attachments WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
        [owner, ids],
      )
    ).rows;
    if (rows.length !== ids.length) throw missing();
    if (rows.some((r) => r.bound_record_id && r.bound_record_id !== id))
      throw invalid("附件已属于另一条记录");
    if (
      rows.filter((r) => r.kind === "image").length >
        SUIJI_LIMITS.imagesPerRecord ||
      rows.filter((r) => r.kind === "markdown").length >
        SUIJI_LIMITS.markdownPerRecord
    )
      throw invalid("每条最多一张图片和一个 Markdown 附件");
    await client.query(
      "UPDATE attachments SET bound_record_id=$3 WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [owner, ids, id],
    );
    await client.query(
      "DELETE FROM record_attachments WHERE owner_id=$1 AND record_id=$2",
      [owner, id],
    );
    for (const [position, attachment] of ids.entries())
      await client.query(
        "INSERT INTO record_attachments(owner_id,record_id,attachment_id,position) VALUES($1,$2,$3,$4)",
        [owner, id, attachment, position],
      );
  }
  private async snapshot(
    client: pg.PoolClient,
    context: Mutation,
    id: string,
    includeTrash = false,
  ) {
    const record = await getRecord(
      client,
      context.ownerId,
      id,
      false,
      includeTrash,
    );
    await client.query(
      "INSERT INTO record_revisions(owner_id,record_id,version,snapshot,request_id,actor) VALUES($1,$2,$3,$4,$5,$6)",
      [
        context.ownerId,
        id,
        record.version,
        JSON.stringify(record),
        context.requestId,
        context.actor,
      ],
    );
    return { record };
  }
}
