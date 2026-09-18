import { z } from "zod";
import { SUIJI_LIMITS, normalizeSuijiTags } from "@runweave/shared/suiji";
const tags = z.array(z.string()).transform((values, ctx) => {
  try {
    return normalizeSuijiTags(values);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: (error as Error).message,
    });
    return z.NEVER;
  }
});
export const uuid = z.string().uuid();
export const body = z
  .string()
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        value,
      ),
    "正文包含不合法 Unicode",
  )
  .refine(
    (value) => [...value].length <= SUIJI_LIMITS.bodyScalars,
    "正文最多 20000 个 Unicode 标量",
  );
const attachmentIds = z
  .array(uuid)
  .max(SUIJI_LIMITS.imagesPerRecord + SUIJI_LIMITS.markdownPerRecord);
export const createSchema = z
  .object({
    kind: z.enum(["note", "task"]),
    body,
    attachmentIds: attachmentIds.optional(),
    tags: tags.optional(),
  })
  .strict();
export const editSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    kind: z.enum(["note", "task"]).optional(),
    body: body.optional(),
    attachmentIds: attachmentIds.optional(),
    tags: tags.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.kind !== undefined ||
      v.body !== undefined ||
      v.tags !== undefined ||
      v.attachmentIds !== undefined,
    "至少提供一个可修改字段",
  );
export const statusSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    targetStatus: z.enum(["open", "done", "archived"]),
  })
  .strict();
export const trashSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    trashed: z.boolean(),
  })
  .strict();
export const listSchema = z
  .object({
    kind: z.enum(["note", "task"]).optional(),
    taskStatus: z.enum(["open", "done", "archived"]).optional(),
    trash: z.literal("true").optional(),
    q: body.optional(),
    tag: z
      .string()
      .transform((value, ctx) => {
        const result = tags.safeParse([value]);
        if (result.success) return result.data[0];
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: result.error.issues[0]?.message ?? "标签无效",
        });
        return z.NEVER;
      })
      .optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SUIJI_LIMITS.maxPageSize)
      .default(SUIJI_LIMITS.defaultPageSize),
  })
  .strict();
export const loginSchema = z
  .object({
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(1024),
  })
  .strict();
export const refreshSchema = z
  .object({ refreshToken: z.string().min(1).max(256) })
  .strict();
export const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
