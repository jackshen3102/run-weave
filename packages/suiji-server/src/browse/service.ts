import { browseEnabled } from "./domain";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { z } from "zod";
import type { BrowseEntryInput, BrowsePage } from "@runweave/shared/suiji";
import { transaction } from "../db/pool";
import { digest, mutate, type Mutation } from "../records/mutations";
import { invalid, ServiceError } from "../errors";
import * as repo from "./repository";
import type * as schema from "./schema";
import { importEntries, getRun } from "./imports";
import { publishDigest, listDigests } from "./digests";
import { listBrowse, changes } from "./queries";
export class BrowseService {
  constructor(private pool: pg.Pool) {}
  private read<T>(work: (c: pg.PoolClient) => Promise<T>) {
    return transaction(this.pool, async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return work(c);
    });
  }
  list(
    owner: string,
    input: z.infer<typeof schema.browseList>,
  ): Promise<BrowsePage> {
    return this.read((c) => listBrowse(c, owner, input));
  }
  changes(owner: string, input: z.infer<typeof schema.changesInput>) {
    return this.read((c) => changes(c, owner, input));
  }
  get(owner: string, id: string) {
    return this.read((c) => repo.getEntry(c, owner, id));
  }
  async history(owner: string, id: string) {
    await repo.getEntry(this.pool, owner, id);
    const row = (
      await this.pool.query(
        "SELECT revisions,followups FROM browse_legacy_archives WHERE owner_id=$1 AND entry_id=$2",
        [owner, id],
      )
    ).rows[0];
    return row ?? { revisions: [], followups: [] };
  }
  async content(
    owner: string,
    id: string,
    input: z.infer<typeof schema.contentInput>,
  ) {
    const entry = await this.get(owner, id);
    checkVersion(entry.version, input.expectedVersion);
    const scalars = [...entry.body];
    if (input.offset > scalars.length) throw invalid("正文读取位置越界");
    const end = Math.min(input.offset + input.limit, scalars.length);
    return {
      id,
      version: entry.version,
      contentHash: entry.contentHash,
      text: scalars.slice(input.offset, end).join(""),
      offset: input.offset,
      totalScalars: scalars.length,
      nextOffset: end < scalars.length ? end : null,
    };
  }
  create(ctx: Mutation, input: BrowseEntryInput) {
    if (
      input.captureMethod === "connector" ||
      input.captureMethod === "legacy" ||
      input.source.connectionId
    )
      throw invalid("连接采集须使用导入接口");
    return mutate(this.pool, ctx, "browse:create", input, async (c) => {
      await repo.lockHead(c, ctx.ownerId);
      const existing = (
        await c.query(
          "SELECT id,capture_hash FROM browse_entries WHERE owner_id=$1 AND capture_id=$2",
          [ctx.ownerId, input.captureId],
        )
      ).rows[0];
      if (existing?.capture_hash === digest(input))
        return { entry: await repo.getEntry(c, ctx.ownerId, existing.id) };
      if (existing)
        throw new ServiceError(
          409,
          "INVALID_ARGUMENT",
          "采集身份已存在，请确认原操作",
        );
      if (
        !input.title.trim() &&
        !input.body.trim() &&
        !input.userNote.trim() &&
        !input.attachmentIds.length &&
        !input.sourceUrl
      )
        throw invalid("请输入内容");
      const id = randomUUID();
      await repo.insertEntry(c, ctx.ownerId, id, input);
      await repo.attach(c, ctx.ownerId, id, input.attachmentIds);
      return { entry: await repo.snapshot(c, ctx.ownerId, id) };
    });
  }
  edit(ctx: Mutation, id: string, input: z.infer<typeof schema.browseEdit>) {
    return mutate(this.pool, ctx, `browse:edit:${id}`, input, async (c) => {
      await repo.lockHead(c, ctx.ownerId);
      const old = await repo.getEntry(c, ctx.ownerId, id);
      checkVersion(old.version, input.expectedVersion);
      if (old.deletedAt) throw invalid("请先恢复条目");
      if (
        input.source &&
        (old.source.connectionId || input.source.connectionId)
      )
        throw invalid("采集连接来源不可编辑");
      if (
        (input.body !== undefined || input.attachmentIds !== undefined) &&
        old.captureMethod === "connector"
      )
        throw invalid("采集原文不可覆盖，请编辑我的备注");
      const body = input.body ?? old.body;
      const ids = input.attachmentIds ?? old.attachments.map((a) => a.id);
      const title = input.title ?? old.title,
        note = input.userNote ?? old.userNote,
        source = input.source ?? old.source;
      if (
        body === old.body &&
        digest(ids) === digest(old.attachments.map((a) => a.id)) &&
        title === old.title &&
        note === old.userNote &&
        digest(source) === digest(old.source)
      )
        return { entry: old };
      if (input.attachmentIds !== undefined)
        await repo.attach(c, ctx.ownerId, id, ids);
      await c.query(
        "UPDATE browse_entries SET title=$3,user_note=$4,source=$5,content_hash=$6,body=$7,version=version+1 WHERE owner_id=$1 AND id=$2",
        [
          ctx.ownerId,
          id,
          title,
          note,
          JSON.stringify(source),
          repo.contentHash({
            ...old,
            title,
            body,
            attachmentIds: ids,
          }),
          body,
        ],
      );
      return { entry: await repo.snapshot(c, ctx.ownerId, id) };
    });
  }
  trash(ctx: Mutation, id: string, input: z.infer<typeof schema.browseTrash>) {
    return mutate(this.pool, ctx, `browse:trash:${id}`, input, async (c) => {
      await repo.lockHead(c, ctx.ownerId);
      const old = await repo.getEntry(c, ctx.ownerId, id);
      checkVersion(old.version, input.expectedVersion);
      if (Boolean(old.deletedAt) === input.trashed) return { entry: old };
      await c.query(
        "UPDATE browse_entries SET deleted_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,version=version+1 WHERE owner_id=$1 AND id=$2",
        [ctx.ownerId, id, input.trashed],
      );
      return { entry: await repo.snapshot(c, ctx.ownerId, id) };
    });
  }
  connections(owner: string) {
    return this.pool
      .query(
        `SELECT id,provider,external_account_id AS "externalAccountId",machine,profile,browser_group AS "group",state,last_success_at AS "lastSuccessAt",(SELECT coverage FROM browse_runs r WHERE r.owner_id=browse_connections.owner_id AND r.connection_id=browse_connections.id ORDER BY r.created_at DESC,r.run_id DESC LIMIT 1) AS "latestCoverage" FROM browse_connections WHERE owner_id=$1 ORDER BY id`,
        [owner],
      )
      .then((r) => ({ items: r.rows }));
  }
  failure(ctx: Mutation, input: z.infer<typeof schema.failureInput>) {
    return mutate(this.pool, ctx, "browse:failure", input, async c => {
      await repo.lockHead(c, ctx.ownerId);
      const connection = (await c.query("SELECT external_account_id FROM browse_connections WHERE owner_id=$1 AND id=$2", [ctx.ownerId,input.connectionId])).rows[0];
      if (!connection || connection.external_account_id !== input.externalAccountId) throw invalid("连接身份不匹配");
      if ((await c.query("SELECT 1 FROM browse_runs WHERE owner_id=$1 AND run_id=$2", [ctx.ownerId,input.runId])).rowCount) throw invalid("runId 已使用，请读取原回执");
      const coverage = { state: "partial", pages: 0, metadata: 0, content: 0, errors: [input.reason] };
      const receipt = { created: 0, updated: 0, unchanged: 0, browseRevision: await repo.head(c,ctx.ownerId) };
      await c.query("INSERT INTO browse_runs(owner_id,run_id,connection_id,request_hash,from_date,to_date,coverage,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [ctx.ownerId,input.runId,input.connectionId,digest(input),input.from,input.to,JSON.stringify(coverage),JSON.stringify(receipt)]);
      return getRun(c,ctx.ownerId,input.runId);
    });
  }
  createConnection(
    ctx: Mutation,
    input: z.infer<typeof schema.connectionCreate>,
  ) {
    return mutate(this.pool, ctx, "browse:connection", input, async (c) => {
      const id = randomUUID();
      await c.query(
        "INSERT INTO browse_connections(owner_id,id,provider,external_account_id,machine,profile,browser_group,state) VALUES($1,$2,$3,$4,$5,$6,$7,'active')",
        [
          ctx.ownerId,
          id,
          input.provider,
          input.externalAccountId,
          input.machine,
          input.profile,
          input.group,
        ],
      );
      return { id, ...input, state: "active", lastSuccessAt: null };
    });
  }
  updateConnection(
    ctx: Mutation,
    id: string,
    input: z.infer<typeof schema.connectionEdit>,
  ) {
    return mutate(
      this.pool,
      ctx,
      `browse:connection:${id}`,
      input,
      async (c) => {
        await repo.lockHead(c, ctx.ownerId);
        const row = await c.query(
          "UPDATE browse_connections SET state=$3 WHERE owner_id=$1 AND id=$2 RETURNING id,state",
          [ctx.ownerId, id, input.state],
        );
        if (!row.rowCount) throw invalid("连接不存在");
        return row.rows[0];
      },
    );
  }
  async import(ctx: Mutation, input: z.infer<typeof schema.browseImport>) {
    if (!(await browseEnabled(this.pool,ctx.ownerId))) throw invalid("请先完成浏览迁移与工作隔离");
    return mutate(this.pool, ctx, "browse:import", input, (c) =>
      importEntries(c, ctx.ownerId, input),
    );
  }
  run(owner: string, id: string) {
    return getRun(this.pool, owner, id);
  }
  digests(owner: string, input: z.infer<typeof schema.digestList>) {
    return listDigests(this.pool, owner, input);
  }
  publishDigest(ctx: Mutation, input: z.infer<typeof schema.digestInput>) {
    return mutate(this.pool, ctx, "browse:digest", input, (c) =>
      publishDigest(c, ctx.ownerId, input),
    );
  }
}
function checkVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new ServiceError(409, "VERSION_CONFLICT", "浏览条目已变化", {
      currentVersion: actual,
    });
}
