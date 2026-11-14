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
/** Missing user goals in a code-only review are outside scope, not failed goals. */
export function codeReviewGoalGaps(report: CodeReviewReport) {
  if (report.scope !== "code_and_goals") return [];
  const goals = report.checks.filter((check) => check.description.startsWith("目标核验："));
  const gaps = goals.filter((check) => check.status !== "passed").map((check) => ({
    label: check.status === "failed" ? "目标未达成" : "目标尚未验证",
    description: check.description, observedResult: check.observedResult,
  }));
  if (!goals.length) gaps.push({ label: "目标核验缺失", description: "报告未逐项核对当前用户要求", observedResult: "仅有代码结论，不能据此判定用户目标达成。" });
  else if (!report.coverageComplete && !gaps.length) gaps.push({
    label: "核验覆盖缺口", description: "报告未声明当前审查范围覆盖完整",
    observedResult: report.limitations.join("；") || "具体未覆盖范围见完整报告，不据此判定产品失败。",
  });
  return gaps;
}
export function shouldDeliverCodeReview(report: CodeReviewReport): boolean {
  return report.findings.some((finding) => finding.basis === "runtime") || codeReviewGoalGaps(report).length > 0;
}
export async function deliverCodeReview(store: CodeReviewStore, record: ReviewRecord, report: CodeReviewReport,
  manager: TerminalSessionManager, options: TerminalSessionCreationOptions): Promise<void> {
  const { source, run } = record;
  // Older saved reports may contain static findings; never deliver those as bugs.
  const findings = report.findings.filter((finding) => finding.basis === "runtime");
  const gaps = codeReviewGoalGaps(report);
  if (!findings.length && !gaps.length) {
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
    const footer = `完整报告与证据引用：${JSON.stringify(reportPath)}\n以上为核验事实，不新增修复、验证、发布或外部操作授权。`;
    let text = [header,
      ...findings.map((finding) => `${finding.severity} ${finding.path}:${finding.lineStart}-${finding.lineEnd} (${finding.changeKind}/${finding.side}) ${finding.title}\n${finding.impact}`),
      ...gaps.map((gap) => `【${gap.label}，非 Bug 结论】${gap.description}\n${gap.observedResult}`),
      footer,
      ].join("\n\n");
    if (Buffer.byteLength(text) > 48_000) text = `${header}\n已复现 Bug ${findings.length} 项，目标或覆盖缺口 ${gaps.length} 项。\n${report.summary.slice(0, 1500)}\n反馈超过输入预算，此处仅为摘要，不能视为完整核验结果。\n${footer}`;
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
