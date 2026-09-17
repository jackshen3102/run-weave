import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
export const experienceIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);
export const evidenceSchema = z
  .object({
    path: text,
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    note: text,
  })
  .strict()
  .refine(
    (v) => v.endLine >= v.startLine && v.endLine - v.startLine < 200,
    "Evidence must reference 1 to 200 lines",
  );
export const draftSchema = z
  .object({
    id: experienceIdSchema,
    title: text,
    triggers: z
      .array(z.array(z.string().trim().min(2).max(120)).min(1).max(15))
      .min(1)
      .max(6),
    applicability: text,
    avoid: z.array(text).min(1).max(10),
    actions: z.array(text).min(1).max(10),
    verification: z.array(text).min(1).max(10),
    expiresAt: z.string().datetime(),
    state: z.enum(["active", "retired", "needs_revalidation"]),
    evidence: z.array(evidenceSchema).min(1).max(10),
    codePaths: z.array(text).max(10).optional(),
  })
  .strict();
export const feedbackSchema = z
  .object({
    lookupId: z.string().uuid(),
    id: experienceIdSchema,
    revision: z.string().uuid(),
    task: text,
    decision: z.enum(["used", "dismissed"]),
    reason: text,
    action: text,
    outcome: text,
    result: z.enum(["succeeded", "failed", "unknown"]).optional(),
    evidence: z.array(evidenceSchema).max(10),
  })
  .strict()
  .refine(
    (v) => v.decision !== "used" || v.evidence.length > 0,
    "Used experience requires outcome evidence",
  );
export const cwdSchema = z.string().trim().min(1).max(4000);
