import { realpathSync } from "node:fs";
import path from "node:path";
import type { CodeReviewReport } from "@runweave/shared/terminal/code-review";
import type { TerminalSessionManager } from "../manager/manager";
import type { TerminalSessionCreationOptions } from "../application/create-session";
import { sendInputToSession } from "../application/input-dispatcher";
import { CodeReviewStore, type ReviewRecord, type SourceBinding } from "./store";
import { reviewDigest } from "./snapshot";

/** Only code location and the originating terminal address; never conversation content. */
export function readSourceBinding(manager: TerminalSessionManager, terminalId: string): SourceBinding {
  const session = manager.getSession(terminalId);
  if (!session) throw new Error("来源终端不存在");
  const project = manager.getProject(session.projectId);
  if (!project?.path) throw new Error("来源终端工作区无法解析");
  return { terminalId, projectId: session.projectId, rootPath: realpathSync(project.path) };
}
export function shouldDeliverCodeReview(report: CodeReviewReport): boolean {
  return report.findings.some((finding) => finding.basis === "runtime");
}
export async function deliverCodeReview(store: CodeReviewStore, record: ReviewRecord, report: CodeReviewReport,
  manager: TerminalSessionManager, options: TerminalSessionCreationOptions): Promise<void> {
  const { source, run } = record;
  // Older saved reports may contain static findings; never deliver those as bugs.
  const findings = report.findings.filter((finding) => finding.basis === "runtime");
  if (!findings.length) {
    run.delivery = "skipped"; run.deliveryError = null;
    await store.save(); return;
  }
  const session = manager.getSession(source.terminalId);
  if (!session) {
    run.delivery = "unavailable"; run.deliveryError = "原终端不存在，报告已保留";
    await store.save(); return;
  }
  store.assertWritable();
  record.delivery.reportHash = reviewDigest(report);
  record.delivery.attemptedAt = new Date().toISOString();
  run.delivery = "writing";
  await store.save();
  try {
    const header = `[runweave-code-review-feedback:${run.reviewId}]\nReview 反馈 · ${run.reviewId} · 第${run.round}轮${run.stale ? "（代码或需求已变化，仅对应原冻结输入）" : ""}`;
    const reportPath = path.join(store.saved(run.reviewId), "report.json");
    const footer = `完整报告与证据引用：${JSON.stringify(reportPath)}\n请按当前任务已有授权核对、修复并验证上述 Bug，不要仅确认收到，也无需再次索取修复授权。用户最新的只读、等待确认、停止或人工接管限制优先。`;
    let text = [header,
      ...findings.map((finding) => `${finding.severity} ${finding.path}:${finding.lineStart}-${finding.lineEnd} (${finding.changeKind}/${finding.side}) ${finding.title}\n${finding.impact}`),
      footer,
      ].join("\n\n");
    if (Buffer.byteLength(text) > 48_000) text = `${header}\n已复现 Bug ${findings.length} 项，问题内容超过输入预算，请读取完整报告中的 findings 及其证据。\n${footer}`;
    // Use exactly the ordinary terminal input path. Its normal sending/queuing
    // behavior applies; Review adds no thread, pane, task or readiness policy.
    await sendInputToSession(manager, options, session, text, "prompt_paste", record.delivery.deliveryId);
    run.delivery = "written"; run.deliveryError = null;
  } catch {
    run.delivery = "unknown";
    run.deliveryError = "回传结果不确定，不自动重复注入；请查看报告";
  }
  await store.save();
}
