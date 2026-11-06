import { z } from "zod";
import { uuid } from "../schema";
import { workDate, workFields } from "../work-records/schema";

export const period = z.object({ from: workDate, to: workDate }).strict().refine(
  v => Date.parse(v.to) - Date.parse(v.from) === 6 * 86400000,
  "周报必须覆盖连续七个自然日（包含首尾）",
);
const body = z.string().refine(v => v.trim().length > 0 && [...v].length <= 20000 &&
  ![...v].some(c => { const n = c.codePointAt(0)!; return (n < 32 && ![9,10,13].includes(n)) || (n >= 127 && n <= 159) || (n >= 0xd800 && n <= 0xdfff); }), "周报正文需为1–20000字");
export const publish = z.object({
  from: workDate, to: workDate, title: workFields.title, body,
  basedOnFeedRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  sourceFacts: z.array(z.object({ id: uuid, version: z.number().int().positive() }).strict()).max(5000),
  expectedVersion: z.number().int().positive().optional(),
}).strict().superRefine((v, ctx) => {
  if (!period.safeParse({ from: v.from, to: v.to }).success)
    ctx.addIssue({ code: "custom", message: "周报必须覆盖连续七个自然日" });
  if (new Set(v.sourceFacts.map(f => f.id)).size !== v.sourceFacts.length)
    ctx.addIssue({ code: "custom", message: "来源事实不能重复" });
});
export const edit = z.object({ title: workFields.title, body, expectedVersion: z.number().int().positive() }).strict();
