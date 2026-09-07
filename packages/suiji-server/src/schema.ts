import { z } from "zod";
import { SUIJI_LIMITS } from "@runweave/shared/suiji";
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
  })
  .strict();
export const editSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    body: body.optional(),
    attachmentIds: attachmentIds.optional(),
  })
  .strict()
  .refine(
    (v) => v.body !== undefined || v.attachmentIds !== undefined,
    "至少提供一个可修改字段",
  );
export const statusSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    targetStatus: z.enum(["done", "archived"]),
  })
  .strict();
export const listSchema = z
  .object({
    kind: z.enum(["note", "task"]).optional(),
    taskStatus: z.enum(["open", "done", "archived"]).optional(),
    q: body.optional(),
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
