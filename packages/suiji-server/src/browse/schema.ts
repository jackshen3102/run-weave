import { z } from "zod";
import { uuid } from "../schema";
import { workDate } from "../work-records/schema";
const text = z
  .string()
  .max(2000000)
  .refine(
    (v) =>
      !v.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        v,
      ),
    "非法 Unicode",
  );
const label = text.pipe(z.string().min(1).max(240));
const timestamp = z.string().datetime({ offset: true });
const url = z
  .string()
  .url()
  .max(4096)
  .refine((v) => /^https?:\/\//i.test(v));
export const entryFields = {
  captureId: uuid,
  browseDate: workDate,
  occurredAt: timestamp.nullable(),
  capturedAt: timestamp,
  title: text.pipe(z.string().max(1000)),
  body: text,
  userNote: text,
  source: z
    .object({
      provider: label,
      displayName: label,
      connectionId: uuid.nullable(),
    })
    .strict(),
  contentType: label,
  captureMethod: z.enum(["connector", "share", "picker", "manual", "legacy"]),
  sourceUrl: url.nullable(),
  contentState: z
    .object({
      state: z.enum(["available", "metadata-only", "unavailable"]),
      reason: label.nullable(),
    })
    .strict(),
  attachmentIds: z.array(uuid).max(2),
};
export const browseCreate = z.object(entryFields).strict();
export const browseEdit = z
  .object({
    body: entryFields.body.optional(),
    attachmentIds: entryFields.attachmentIds.optional(),
    expectedVersion: z.number().int().positive(),
    title: entryFields.title.optional(),
    userNote: text.optional(),
    source: entryFields.source.optional(),
  })
  .strict();
export const browseTrash = z
  .object({
    expectedVersion: z.number().int().positive(),
    trashed: z.boolean(),
  })
  .strict();
export const browseList = z
  .object({
    source: label.optional(),
    type: label.optional(),
    from: workDate.optional(),
    to: workDate.optional(),
    q: text.pipe(z.string().max(1000)).optional(),
    trash: z.literal("true").optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to);
export const connectionCreate = z
  .object({
    provider: label,
    externalAccountId: label,
    machine: label,
    profile: label,
    group: label,
  })
  .strict();
export const connectionEdit = z
  .object({ state: z.enum(["active", "disabled"]) })
  .strict();
export const browseImport = z
  .object({
    runId: uuid,
    connectionId: uuid,
    externalAccountId: label,
    from: workDate,
    to: workDate,
    identityBefore: label,
    identityAfter: label,
    coverage: z
      .object({
        state: z.enum(["complete", "partial"]),
        pages: z.number().int().min(0).max(300),
        metadata: z.number().int().min(0),
        content: z.number().int().min(0),
        errors: z.array(label).max(200),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            observation: z
              .object({
                contentType: label,
                contentId: label,
                readTime: timestamp,
                observedAt: timestamp,
              })
              .strict(),
            entry: browseCreate,
          })
          .strict(),
      )
      .max(6000),
  })
  .strict()
  .refine((v) => v.from <= v.to);
export const digestInput = z
  .object({
    date: workDate,
    connectionId: uuid,
    title: entryFields.title,
    body: text,
    entryRefs: z
      .array(
        z
          .object({
            id: uuid,
            version: z.number().int().positive(),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(6000),
    inputRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  })
  .strict();
export const digestList = z
  .object({ date: workDate, connectionId: uuid })
  .strict();
export const changesInput = z
  .object({
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export const contentInput = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(16000).default(4000),
    expectedVersion: z.coerce.number().int().positive(),
  })
  .strict();

export const failureInput = z.object({ runId: uuid, connectionId: uuid, externalAccountId: label, from: workDate, to: workDate, reason: z.enum(["needs-login", "unavailable", "identity-changed", "parse-failed", "timeout", "rate-limited"]) }).strict().refine(v => v.from <= v.to);
