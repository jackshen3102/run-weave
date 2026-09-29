import { z } from "zod";
import type { CorrectionLexiconEntry } from "@runweave/shared/suiji";
import { body } from "../schema";

const term = z.string().transform((value, ctx) => {
  const trimmed = value.trim();
  const scalars = [...trimmed];
  if (!scalars.length || scalars.length > 80 || [...trimmed].some((c) => {
    const code = c.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff);
  })) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "词条须为 1–80 个 Unicode 标量且不能包含控制字符" });
    return z.NEVER;
  }
  return trimmed;
});
export const lexiconInput = z.object({
  expectedVersion: z.number().int().min(0),
  entries: z.array(z.object({ canonical: term, variants: z.array(term).max(5) }).strict()).max(200),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const entry of value.entries) for (const spelling of [entry.canonical, ...entry.variants]) {
    if (seen.has(spelling)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "词库写法不能重复" });
    seen.add(spelling);
  }
});
export function validateEntries(entries: CorrectionLexiconEntry[]) {
  return lexiconInput.parse({ expectedVersion: 0, entries }).entries;
}
export const correctionInput = z.object({
  text: body.refine((s) => s.trim().length > 0, "纠错文本不能为空"),
  recordId: z.string().uuid().optional(),
  feedbackCapable: z.boolean().optional(),
}).strict();
export const preferenceInput = z.object({ expectedVersion: z.number().int().min(0), historyEnabled: z.boolean() }).strict();
export const feedbackInput = z.object({
  recordId: z.string().uuid(), recordVersion: z.number().int().positive(), saveKey: z.string().uuid(),
}).strict();
export const modelCorrection = z.object({
  correctedText: body.refine((s) => s.trim().length > 0),
  uncertainTerms: z.array(z.string().min(1).max(80)).max(10),
  suggestedTerms: z.array(z.object({ variant: z.string().min(1).max(80), canonical: z.string().min(1).max(80) }).strict()).max(20),
}).strict();
export const correctionOutputSchema = {
  type: "object", additionalProperties: false,
  required: ["correctedText", "uncertainTerms", "suggestedTerms"],
  properties: {
    correctedText: { type: "string" },
    uncertainTerms: { type: "array", items: { type: "string" } },
    suggestedTerms: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["variant", "canonical"], properties: { variant: { type: "string" }, canonical: { type: "string" } } } },
  },
} as const;
