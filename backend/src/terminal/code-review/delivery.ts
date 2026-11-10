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
    const text = [run.stale ? "代码已变化，请按当前代码核对并修复以下 Review 问题：" : "请核对并修复以下 Review 问题：",
      ...findings.map((finding) => `${finding.severity} ${finding.path}:${finding.lineStart}-${finding.lineEnd} (${finding.changeKind}/${finding.side}) ${finding.title}\n${finding.impact}`),
      ].join("\n\n");
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
