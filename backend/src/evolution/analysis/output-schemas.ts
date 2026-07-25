import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const evidenceIdsSchema = z.array(z.string().min(1)).max(200);
const assessmentDimensionSchema = z.enum([
  "intent_understanding",
  "goal_outcome",
  "action_quality",
  "self_correction",
  "efficiency",
  "safety",
]);

export const analystOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    observedFacts: z
      .array(
        z
          .object({
            statement: z.string().min(1).max(2_000),
            evidenceIds: evidenceIdsSchema.min(1),
          })
          .strict(),
      )
      .max(100),
    assessments: z
      .array(
        z
          .object({
            dimension: assessmentDimensionSchema,
            value: z.enum(["positive", "negative", "mixed", "unknown"]),
            evidenceIds: evidenceIdsSchema,
            rationale: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .max(24),
    claims: z
      .array(
        z
          .object({
            topicKey: z
              .string()
              .trim()
              .min(1)
              .max(120)
              .regex(/^[a-z0-9][a-z0-9._-]*$/u),
            statement: z.string().min(1).max(2_000),
            scope: z.string().min(1).max(1_000),
            supportingEvidenceIds: evidenceIdsSchema.min(1),
            counterEvidenceIds: evidenceIdsSchema,
            candidateType: z
              .enum(["memory", "prompt", "skill", "routing", "product", "code"])
              .nullable(),
            guidance: z.string().min(1).max(2_000).nullable(),
            risk: z.enum(["low", "medium", "high"]),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export const crossQuestionOutputSchema = z
  .object({
    reviews: z
      .array(
        z
          .object({
            topicKey: z.string().min(1).max(120),
            status: z.enum([
              "corroborated",
              "contested",
              "insufficient_evidence",
              "rejected",
            ]),
            counterEvidenceIds: evidenceIdsSchema,
            missingEvidence: z.array(z.string().min(1).max(1_000)).max(50),
            rationale: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type AnalystOutput = z.infer<typeof analystOutputSchema>;
export type CrossQuestionOutput = z.infer<
  typeof crossQuestionOutputSchema
>;

export function analystOutputJsonSchema(): object {
  return zodToJsonSchema(analystOutputSchema, {
    name: "EvolutionAnalystOutput",
    $refStrategy: "none",
  });
}

export function crossQuestionOutputJsonSchema(): object {
  return zodToJsonSchema(crossQuestionOutputSchema, {
    name: "EvolutionCrossQuestionOutput",
    $refStrategy: "none",
  });
}
