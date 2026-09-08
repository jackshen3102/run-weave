import { z } from "zod";
import { body, keySchema, uuid } from "../schema";

const filters = {
  kind: z.enum(["note", "task"]).optional(),
  taskStatus: z.enum(["open", "done", "archived"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().max(2048).optional(),
};
export const listInput = z
  .object({
    ...filters,
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const searchInput = z
  .object({
    ...filters,
    query: body.refine((value) => value.trim().length > 0, "搜索词不能为空"),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export const getInput = z.object({ recordId: uuid }).strict();
export const createInput = z
  .object({
    kind: z.enum(["note", "task"]),
    body,
    idempotencyKey: keySchema,
  })
  .strict();
export const replaceInput = z
  .object({
    recordId: uuid,
    body,
    expectedVersion: z.number().int().positive(),
    idempotencyKey: keySchema,
  })
  .strict();
export const statusInput = z
  .object({
    recordId: uuid,
    targetStatus: z.enum(["open", "done", "archived"]),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: keySchema,
  })
  .strict();
export const attachmentInput = z
  .object({
    attachmentId: uuid,
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(16000).default(4000),
  })
  .strict();
