import { z } from "zod";
import { uuid } from "../schema";

export const workDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(d.valueOf()) &&
      d.toISOString().slice(0, 10) === value &&
      value >= "0001-01-01"
    );
  }, "工作日期无效");
const unicode = z.string().refine(
  (value) =>
    ![...value].some((c) => {
      const n = c.codePointAt(0)!;
      return (n < 32 && ![9, 10, 13].includes(n)) || (n >= 127 && n <= 159);
    }) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    ),
  "包含非法 Unicode 或控制字符",
);
const short = unicode
  .transform((v) => v.trim())
  .refine(
    (v) => [...v].length >= 1 && [...v].length <= 80 && !/[\r\n\t]/.test(v),
    "需为1–80字",
  );
export const project = unicode
  .transform((v) => v.trim() || null)
  .refine(
    (v) => v === null || ([...v].length <= 80 && !/[\r\n\t]/.test(v)),
    "项目最多80字",
  )
  .nullable();
export const workStatus = z.enum([
  "progress",
  "discussed",
  "documented",
  "attempted",
  "agent-reported",
  "verified",
]);
export const workFields = {
  workDate,
  title: short,
  statement: unicode.refine(
    (v) => v.trim().length > 0 && [...v].length <= 4000,
    "正文需为1–4000字",
  ),
  status: workStatus,
  project,
};
export const workCreate = z.object(workFields).strict();
// Explicit shape preserves the shared field types for both HTTP and MCP adapters.
export const workEdit = z
  .object({
    expectedVersion: z.number().int().positive(),
    workDate: workDate.optional(),
    title: short.optional(),
    statement: workFields.statement.optional(),
    status: workStatus.optional(),
    project: project.optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).some((k) => k !== "expectedVersion"),
    "至少提供一个字段",
  );
export const reclassify = z
  .object({
    items: z
      .array(
        z
          .object({ id: uuid, expectedVersion: z.number().int().positive() })
          .strict(),
      )
      .min(1)
      .max(100),
    project,
  })
  .strict()
  .refine(
    (v) => new Set(v.items.map((i) => i.id)).size === v.items.length,
    "ID 不得重复",
  );
export const restoreProjects = z
  .object({
    items: z
      .array(
        z
          .object({
            id: uuid,
            expectedVersion: z.number().int().positive(),
            project,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (v) => new Set(v.items.map((i) => i.id)).size === v.items.length,
    "ID 不得重复",
  );
export const workList = z
  .object({
    from: workDate.optional(),
    to: workDate.optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || v.from <= v.to,
    "起始日期不得晚于结束日期",
  );
export const stableKey = unicode.refine(
  (v) =>
    [...v].length >= 1 &&
    [...v].length <= 240 &&
    !/[\r\n\t]/.test(v) &&
    !/^(?:\/|~|[A-Za-z]:[\\/])/.test(v),
  "稳定身份无效",
);
const nativeId = stableKey.refine(
  (v) => !v.includes("://") && !/[\\/]/.test(v),
  "原生标识不能为URL或路径",
);
const scope = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const timestamp = z.string().datetime({ offset: true });
const receipt = z
  .object({
    sourceScope: scope,
    status: z.enum(["complete", "partial", "unavailable"]),
    collectedAt: timestamp,
    from: timestamp,
    to: timestamp,
  })
  .strict();
const sourceRef = z
  .object({
    channel: z.enum(["local-agent", "feishu-message", "feishu-document"]),
    sourceScope: scope,
    nativeId,
    revision: nativeId.optional(),
    hash: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  })
  .strict();
const imported = z
  .object({
    externalKey: stableKey,
    eventKey: stableKey,
    title: short,
    statement: workFields.statement,
    status: workStatus,
    project,
    sourceRefs: z.array(sourceRef).min(1).max(100),
  })
  .strict();
export const workImport = z
  .object({
    schemaVersion: z.literal(1),
    sourceNamespace: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    sourceCollectedAt: timestamp,
    basedOnFeedRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
    days: z
      .array(
        z
          .object({
            date: workDate,
            requestedScopes: z.array(scope).min(1).max(100),
            receipts: z.array(receipt).min(1).max(100),
            facts: z.array(imported).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (
      Buffer.byteLength(JSON.stringify(v)) > 200 * 1024 ||
      v.days.reduce((n, d) => n + d.facts.length, 0) > 100
    )
      issue("单包最多100条且不超过200KiB；按完整日期分包");
    const dates = new Set<string>(),
      keys = new Set<string>();
    let collected = -Infinity;
    for (const d of v.days) {
      if (dates.has(d.date)) issue("日期不得重复");
      dates.add(d.date);
      const scopes = new Set(d.requestedScopes);
      if (
        scopes.size !== d.requestedScopes.length ||
        d.receipts.length !== scopes.size ||
        new Set(d.receipts.map((r) => r.sourceScope)).size !== scopes.size
      )
        issue("每个请求范围必须恰有一条回执");
      const from = new Date(`${d.date}T00:00:00+08:00`).valueOf(),
        to = from + 86400000;
      for (const r of d.receipts) {
        if (
          !scopes.has(r.sourceScope) ||
          Date.parse(r.from) !== from ||
          Date.parse(r.to) !== to
        )
          issue("读取范围不匹配工作日或来源范围");
        collected = Math.max(collected, Date.parse(r.collectedAt));
      }
      for (const f of d.facts) {
        if (keys.has(f.externalKey)) issue("externalKey 不得重复");
        keys.add(f.externalKey);
        if (
          f.sourceRefs.some(
            (ref) =>
              !scopes.has(ref.sourceScope) ||
              !d.receipts.some(
                (r) =>
                  r.sourceScope === ref.sourceScope &&
                  r.status !== "unavailable",
              ),
          )
        )
          issue("事实来源未实际读取");
      }
    }
    if (Date.parse(v.sourceCollectedAt) !== collected)
      issue("sourceCollectedAt必须为实际回执最大采集时刻");
  });
