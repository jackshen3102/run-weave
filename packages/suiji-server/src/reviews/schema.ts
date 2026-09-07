import { z } from "zod";
import { uuid } from "../schema";

export const reviewInput = z
  .object({
    question: z
      .string()
      .min(1)
      .max(4000)
      .refine((s) => s.trim().length > 0),
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("all") }).strict(),
      z.object({ kind: z.literal("open") }).strict(),
      z.object({ kind: z.literal("record"), recordId: uuid }).strict(),
    ]),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().max(16000),
          })
          .strict(),
      )
      .max(6)
      .default([]),
  })
  .strict();

export const modelAnswer = z
  .object({
    text: z.string().min(1).max(16000),
    citations: z
      .array(
        z
          .object({
            recordId: uuid,
            version: z.number().int().positive(),
            quote: z.string().max(1200),
            attachmentId: uuid.nullable(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

// Codex structured output uses a closed JSON Schema, separate from HTTP input validation.
export const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "citations"],
  properties: {
    text: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["recordId", "version", "quote", "attachmentId"],
        properties: {
          recordId: { type: "string" },
          version: { type: "integer" },
          quote: { type: "string" },
          attachmentId: { type: ["string", "null"] },
        },
      },
    },
  },
};
