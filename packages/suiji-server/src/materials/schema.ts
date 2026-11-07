import { z } from "zod";

export const materialDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value && value >= "0001-01-01";
}, "素材日期无效");
export const materialInput = z.object({
  captureId: z.string().uuid(),
  capturedAt: z.string().datetime({ offset: true }),
  materialDate,
  inputType: z.enum(["image", "text", "link"]),
  sourceUrl: z.string().max(8000).url().refine(value => /^https?:\/\//i.test(value), "只接受 HTTP(S) 链接").optional(),
}).strict();
export const materialFilters = {
  category: z.enum(["idea", "task", "material"]).optional(),
  materialFrom: materialDate.optional(),
  materialTo: materialDate.optional(),
};
