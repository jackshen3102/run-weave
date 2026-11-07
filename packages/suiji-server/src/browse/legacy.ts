import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CreateRecord, SuijiRecord } from "@runweave/shared/suiji";
import type { Mutation } from "../records/mutations";
import { invalid } from "../errors";
import * as repo from "./repository";
export async function createLegacy(
  c: pg.PoolClient,
  ctx: Mutation,
  input: CreateRecord,
) {
  if (!input.material || input.kind !== "note") throw invalid("旧素材请求无效");
  const m = input.material;
  await repo.lockHead(c, ctx.ownerId);
  const prior = (
    await c.query(
      "SELECT id FROM browse_entries WHERE owner_id=$1 AND capture_id=$2",
      [ctx.ownerId, m.captureId],
    )
  ).rows[0];
  let entry;
  if (prior) {
    entry = await repo.getEntry(c, ctx.ownerId, prior.id);
    if (
      entry.body !== input.body || entry.contentType !== m.inputType || Date.parse(entry.capturedAt) !== Date.parse(m.capturedAt) ||
      entry.browseDate !== m.materialDate ||
      entry.sourceUrl !== (m.sourceUrl ?? null) ||
      JSON.stringify(entry.attachments.map((a) => a.id)) !==
        JSON.stringify(input.attachmentIds ?? [])
    )
      throw invalid("采集身份已使用，请核对原冻结请求");
  } else {
    const id = randomUUID();
    await repo.insertEntry(c, ctx.ownerId, id, {
      captureId: m.captureId,
      browseDate: m.materialDate,
      occurredAt: null,
      capturedAt: m.capturedAt,
      title: m.inputType === "image" ? "保存的图片" : "保存的内容",
      body: input.body,
      userNote: "",
      source: {
        provider: "unknown",
        displayName: "未标注",
        connectionId: null,
      },
      contentType: m.inputType,
      captureMethod: "legacy",
      sourceUrl: m.sourceUrl ?? null,
      contentState: { state: "available", reason: null },
      attachmentIds: input.attachmentIds ?? [],
    });
    await repo.attach(c, ctx.ownerId, id, input.attachmentIds ?? []);
    entry = await repo.snapshot(c, ctx.ownerId, id);
  }
  // App-only compatibility response. This is never exposed as an ordinary record read.
  const record: SuijiRecord = {
    id: entry.id,
    kind: "note",
    body: input.body,
    taskStatus: null,
    version: entry.version,
    createdAt: entry.capturedAt,
    updatedAt: entry.capturedAt,
    createdVia: ctx.actor,
    deletedAt: entry.deletedAt,
    tags: input.tags ?? [],
    attachments: entry.attachments,
    material: {
      ...m,
      sourceHash: entry.contentHash,
      processedVersion: null,
      processedAt: null,
    },
  };
  return { record, migrated: true, browseEntryId: entry.id };
}
