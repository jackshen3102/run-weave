import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CodeReviewReport, CodeReviewSnapshot } from "@runweave/shared/terminal/code-review";
import { atomicJson, CodeReviewError, CodeReviewStore, readOwnedFile } from "./store";
const text = z.string().min(1).max(16000);
const kind = z.enum(["staged", "working"]);
const refs = z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).max(100);
export const codeReviewReportSchema = z.object({
  schemaVersion: z.literal(1), reviewId: z.string(), snapshotId: z.string(), fingerprint: z.string(),
  summary: text, findings: z.array(z.object({
    severity: z.enum(["P0", "P1", "P2", "P3"]), title: text, path: text, changeKind: kind,
    side: z.enum(["old", "new"]), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(),
    impact: text, basis: z.enum(["static", "runtime"]), evidenceRefs: refs,
  }).strict()).max(500),
  checks: z.array(z.object({ description: text, status: z.enum(["passed", "failed", "not_run"]),
    environment: text, observedResult: text, evidenceRefs: refs,
    beforeFingerprint: z.string().nullable(), afterFingerprint: z.string().nullable(),
  }).strict()).min(1).max(500),
  reviewedChanges: z.array(z.object({ path: text, changeKind: kind }).strict()).max(10000),
  limitations: z.array(text).max(10000), coverageComplete: z.boolean(), cleanup: text,
  artifacts: z.array(z.object({ artifactId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), path: text,
    mimeType: z.enum(["text/plain", "application/json", "image/png", "image/jpeg"]),
  }).strict()).max(100),
}).strict();

/** Structural validation cannot establish semantic correctness or actual reproduction. */
export async function saveReviewReport(store: CodeReviewStore, reviewId: string, snapshot: CodeReviewSnapshot, final: string): Promise<CodeReviewReport> {
  if (Buffer.byteLength(final) > 2 * 1024 * 1024) throw new CodeReviewError(413, "report_invalid", "报告超过大小上限");
  let report: CodeReviewReport;
  try { report = codeReviewReportSchema.parse(JSON.parse(final.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, "$1"))); }
  catch { throw new CodeReviewError(422, "report_invalid", "最终报告不是约定的完整 JSON"); }
  const invalid = (message: string): never => { throw new CodeReviewError(422, "report_invalid", message); };
  if (report.reviewId !== reviewId || report.snapshotId !== snapshot.snapshotId || report.fingerprint !== snapshot.fingerprint)
    invalid("报告身份或快照指纹不匹配");
  const key = (item: { path: string; changeKind: string }) => JSON.stringify([item.changeKind, item.path]);
  const entries = new Map(snapshot.entries.map((entry) => [key(entry), entry]));
  const reviewed = new Set(report.reviewedChanges.map(key));
  if (reviewed.size !== report.reviewedChanges.length || [...reviewed].some((id) => !entries.has(id))) invalid("报告包含重复或范围外的受审项");
  for (const entry of snapshot.entries) {
    if (!entry.omission && !reviewed.has(key(entry))) invalid("报告未逐项交代受审文件");
  }
  for (const finding of report.findings) {
    const entry = entries.get(key(finding));
    const content = entry?.[finding.side].content;
    if (content === null || content === undefined || finding.lineEnd < finding.lineStart || finding.lineEnd > content.split("\n").length)
      invalid("问题位置不属于快照可读侧");
    if (finding.basis === "runtime" && !finding.evidenceRefs.length) invalid("运行时问题缺少证据引用");
  }
  for (const check of report.checks) {
    if (check.status !== "not_run" && (check.beforeFingerprint !== snapshot.fingerprint || check.afterFingerprint !== snapshot.fingerprint || !check.evidenceRefs.length)) {
      check.status = "not_run";
      check.observedResult = "缺少同版指纹或运行证据，原结果不能作为快照验证。";
      report.coverageComplete = false;
    }
  }
  for (const finding of report.findings) {
    if (finding.basis === "runtime" && !report.checks.some((check) => check.status !== "not_run" &&
        check.beforeFingerprint === snapshot.fingerprint && check.afterFingerprint === snapshot.fingerprint &&
        finding.evidenceRefs.every((id) => check.evidenceRefs.includes(id))))
      invalid("运行时问题缺少关联的同版已执行检查");
  }
  report.limitations = [...new Set([...report.limitations, ...snapshot.omissions])];
  if (snapshot.omissions.length || report.checks.some((check) => check.status === "not_run") || report.limitations.length)
    report.coverageComplete = false;
  const ids = new Set<string>();
  let total = 0;
  const artifactDir = path.join(store.saved(reviewId), "artifacts");
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  for (const artifact of report.artifacts) {
    if (ids.has(artifact.artifactId)) invalid("重复产物 ID");
    ids.add(artifact.artifactId);
    const bytes = await readOwnedFile(store.output(reviewId), artifact.path, 20 * 1024 * 1024);
    total += bytes.length;
    if (total > 64 * 1024 * 1024) invalid("证据超过本轮大小上限");
    // Copy into Backend-owned names. HTTP never opens the model's path again.
    const file = path.join(artifactDir, artifact.artifactId);
    await writeFile(file, bytes, { mode: 0o600 }); await chmod(file, 0o600);
  }
  for (const item of [...report.findings, ...report.checks])
    if (item.evidenceRefs.some((id) => !ids.has(id))) invalid("报告引用未登记的证据");
  await atomicJson(path.join(store.saved(reviewId), "report.json"), report);
  return report;
}
