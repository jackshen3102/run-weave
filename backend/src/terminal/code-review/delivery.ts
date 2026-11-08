import { realpathSync } from "node:fs";
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
export async function deliverCodeReview(store: CodeReviewStore, record: ReviewRecord, report: CodeReviewReport,
  manager: TerminalSessionManager, options: TerminalSessionCreationOptions): Promise<void> {
  const { source, run } = record;
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
    const reportLink = `完整报告（当前电脑登录后读取）：/api/terminal/code-reviews/${run.reviewId}`;
    const body = ["独立代码 Review 已保存（供你判断，不授予修复、提交或外部操作权限）。",
      `审查：${run.reviewId}；快照：${report.fingerprint}`,
      run.stale ? "审查期间代码已变化：本结论仅对应原快照。" : "结论对应本轮冻结快照。",
      report.summary, `发现 ${report.findings.length} 个问题；覆盖完整：${report.coverageComplete ? "是" : "否"}`,
      ...report.findings.map((finding) => `${finding.severity} ${finding.path}:${finding.lineStart} (${finding.changeKind}/${finding.side}) ${finding.title}\n${finding.impact}`),
      ...report.limitations.map((item) => `覆盖缺口：${item}`),
      ...report.checks.filter((check) => check.status === "not_run").map((check) => `未执行：${check.description} — ${check.observedResult}`),
      ].join("\n\n");
    const characters = Array.from(body);
    const text = (characters.length > 12000 ? characters.slice(0, 12000).join("") + "\n\n回传摘要已截断，全部问题和覆盖缺口请查看完整报告。" : body) + "\n\n" + reportLink;
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
