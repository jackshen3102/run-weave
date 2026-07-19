import { z } from "zod";

export const findingDispositionSchema = z
  .object({
    invariantKey: z.string().trim().min(1),
    disposition: z.enum(["blocking", "out_of_scope", "waived"]),
    caseIds: z.array(z.string().trim().min(1)).optional(),
    reason: z.string().trim().min(1),
  })
  .strict();
export const acceptanceDispositionSchema = z
  .object({
    caseId: z.string().trim().min(1),
    disposition: z.enum(["accepted_environment_skip", "invalid_case"]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const focusSchema = z
  .object({ panelId: z.string().trim().min(1) })
  .strict();
export const exportQuerySchema = z
  .object({
    history: z.enum(["none", "tail", "full"]).optional(),
    tail: z.coerce.number().int().positive().max(5000).optional(),
    includeSessionOther: z
      .enum(["true", "false"])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : value === "true",
      ),
    includeOutboxes: z
      .enum(["true", "false"])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : value === "true",
      ),
  })
  .strict();
