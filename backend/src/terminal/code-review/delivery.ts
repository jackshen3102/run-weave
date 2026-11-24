import { realpathSync } from "node:fs";
import path from "node:path";
import type { CodeReviewReport, CreateCodeReviewRequest } from "@runweave/shared/terminal/code-review";
import type { TerminalSessionManager } from "../manager/manager";
import type { TerminalSessionCreationOptions } from "../application/create-session";
import { sendInputToSession } from "../application/input-dispatcher";
import { resolveConversationTarget } from "../application/conversation";
import { buildPaneTarget } from "../application/panel-common";
import { readCodexContext } from "../runtime/codex-context";
import { beginSupervisorDelivery, captureTerminalPaneInput, hasPendingTerminalInput, TerminalInputBusyError } from "../runtime/input-admission";
import { CodeReviewError, type CodeReviewStore, type ReviewRecord, type SourceBinding } from "./store";

/** Only code location and the originating terminal address; never conversation content. */
export function readSourceBinding(manager: TerminalSessionManager, terminalId: string): SourceBinding {
  const session = manager.getSession(terminalId);
  if (!session) throw new Error("来源终端不存在");
  const project = manager.getProject(session.projectId);
  if (!project?.path) throw new Error("来源终端工作区无法解析");
  return { terminalId, projectId: session.projectId, rootPath: realpathSync(project.path) };
}
export function bindReviewReply(manager: TerminalSessionManager, options: TerminalSessionCreationOptions,
  source: SourceBinding, locator: NonNullable<CreateCodeReviewRequest["replyTo"]>, hasHumanControl: () => boolean) {
  const session = manager.getSession(source.terminalId);
  const panels = manager.listPanels(source.terminalId).filter((panel) => panel.status === "running");
  const panel = locator.panelId ? panels.find((item) => item.id === locator.panelId)
    : locator.tmuxPaneId ? panels.find((item) => item.tmuxPaneId === locator.tmuxPaneId)
    : panels.length === 1 ? panels[0] : undefined;
  const runtime = session?.runtimeKind === "pty" ? options.runtimeRegistry?.getSessionRuntime(session.id) : undefined;
  if (!session || session.status !== "running" || (session.runtimeKind === "tmux"
    ? !panel || !options.tmuxService || (locator.tmuxPaneId && panel.tmuxPaneId !== locator.tmuxPaneId)
    : !runtime || panel || locator.tmuxPaneId || (locator.panelId && locator.panelId !== "default")))
    throw new CodeReviewError(409, "review_source_unavailable", "无法确定回传面板；请从原 Agent 会话发起，或显式指定 --panel-id");
  const { target, agent } = resolveConversationTarget(manager, session.id, panel?.id);
  if (!target || !agent || target.provider !== agent)
    throw new CodeReviewError(409, "review_source_unavailable", "原终端没有可回传的 Agent 会话");
  const context = panel && agent === "codex" ? readCodexContext(panel) : undefined;
  if (context?.managed && (context.context?.closed || context.context?.displayedThreadId !== target.threadId ||
                           context.context?.primaryThreadId !== target.threadId))
    throw new CodeReviewError(409, "review_source_unavailable", "请从 Codex 原主会话发起 Review");
  const panelId = panel?.id ?? null;
  const generation = () => manager.getPanelAgentOperationGeneration(session.id, panelId ?? "default")?.operationId;
  const operationId = generation();
  const paneId = panel?.tmuxPaneId ?? null;
  const tmuxService = options.tmuxService;
  const pane = panel && tmuxService ? buildPaneTarget(session, tmuxService, panel) : undefined;
  const tmuxSocket = session.tmuxSocketPath;
  const tmuxSession = session.tmuxSessionName;
  const inputChanged = captureTerminalPaneInput(session, paneId);
  const status = () => {
    if (manager.getSession(session.id) !== session || session.status !== "running" ||
      session.projectId !== source.projectId || generation() !== operationId ||
      session.tmuxSocketPath !== tmuxSocket || session.tmuxSessionName !== tmuxSession ||
      (runtime && options.runtimeRegistry?.getSessionRuntime(session.id) !== runtime) ||
      (panel && (manager.getPanel(panel.id) !== panel || panel.status !== "running" || panel.tmuxPaneId !== paneId))) return "changed";
    if (hasHumanControl() || inputChanged() || hasPendingTerminalInput(session, paneId)) return "human";
    try {
      const current = resolveConversationTarget(manager, session.id, panel?.id);
      if (current.agent !== agent || current.target?.threadId !== target.threadId || current.target.panelId !== panelId) return "changed";
    } catch { return "changed"; }
    const owner = panel ?? session;
    const observed = panel && agent === "codex" ? readCodexContext(panel) : undefined;
    if (observed?.managed) {
      if (!observed.context || observed.context.closed || observed.context.primaryThreadId !== target.threadId) return "changed";
      if (observed.context.displayedThreadId !== target.threadId || observed.context.displayedRunning !== false) return "busy";
    }
    return owner.terminalState?.state === "agent_idle" && owner.terminalState.agent === agent ? "ready" : "busy";
  };
  const acquire = () => beginSupervisorDelivery(session);
  return { target: { panelId, threadId: target.threadId }, pane, status, acquire };
}
export type ReviewReply = ReturnType<typeof bindReviewReply>;

export async function deliverCodeReview(store: CodeReviewStore, record: ReviewRecord, report: CodeReviewReport | null,
  manager: TerminalSessionManager, options: TerminalSessionCreationOptions, reply?: ReviewReply): Promise<void> {
  const { source, run } = record;
  // Older saved reports may contain static findings; never deliver those as bugs.
  const findings = report?.findings.filter((finding) => finding.basis === "runtime") ?? [];
  if (!source.replyTarget && !findings.length) {
    run.delivery = "skipped"; run.deliveryError = null;
    await store.save(); return;
  }
  const session = manager.getSession(source.terminalId);
  if (!session) {
    run.delivery = "unavailable"; run.deliveryError = "原终端不存在，报告已保留";
    await store.save(); return;
  }
  const status = reply?.status();
  if (source.replyTarget && status !== "ready") {
    if (status === "busy") return;
    run.delivery = !reply ? "unavailable" : "target_changed";
    run.deliveryError = status === "human" ? "来源终端输入或控制权已变化，结果可在 Review 记录中查看"
      : "无法确认原 Agent 会话仍可安全回传，结果可在 Review 记录中查看";
    await store.save(); return;
  }
  let release: (() => Promise<void>) | undefined;
  try { release = reply?.acquire(); }
  catch (error) { if (error instanceof TerminalInputBusyError) return; throw error; }
  try {
    store.assertWritable();
    record.delivery.attemptedAt = new Date().toISOString();
    run.delivery = "writing";
    await store.save();
    try {
      const header = `[runweave-code-review-feedback:${run.reviewId}]\nReview 反馈 · ${run.reviewId} · 第${run.round}轮${run.stale ? "（代码或需求已变化，仅对应原冻结输入）" : ""}`;
      const reportPath = path.join(store.saved(run.reviewId), "report.json");
      const entry = report ? `完整报告与证据引用：${JSON.stringify(reportPath)}` : `运行记录：rw terminal review show ${run.reviewId} --json`;
      let text: string;
      if (findings.length) {
        const footer = `${entry}\n请按当前任务已有授权核对、修复并验证上述 Bug，不要仅确认收到，也无需再次索取修复授权。用户最新的只读、等待确认、停止或人工接管限制优先。`;
        text = [header, ...findings.map((finding) => `${finding.severity} ${finding.path}:${finding.lineStart}-${finding.lineEnd} (${finding.changeKind}/${finding.side}) ${finding.title}\n${finding.impact}`), footer].join("\n\n");
        if (Buffer.byteLength(text) > 48_000) text = `${header}\n已复现 Bug ${findings.length} 项，问题内容超过输入预算，请读取完整报告中的 findings 及其证据。\n${footer}`;
      } else {
        const outcome = run.phase === "completed" ? `本轮审查通过，未发现已复现 Bug。${run.scope === "code" ? "本轮范围仅限代码。" : ""}`
          : `${run.phase === "cancelled" ? "审查已中断" : report ? "验收阻塞" : "审查运行失败"}。${run.error?.message ?? "请查看本轮记录。"}`;
        text = `${header}\n${outcome}\n${entry}\n请向用户简要报告本轮结果。`;
      }
      const validateSupervisorTarget = () => {
        if (reply?.status() !== "ready") throw new Error("Original Review conversation is no longer ready");
      };
      if (reply && reply.status() !== "ready") {
        run.delivery = "target_changed"; run.deliveryError = "回传前原会话状态已变化，结果可在 Review 记录中查看";
      } else {
        await sendInputToSession(manager, reply ? { ...options, supervisorInput: true, validateSupervisorTarget } : options,
          session, text, "prompt_paste", record.delivery.deliveryId, reply?.pane);
        run.delivery = "written"; run.deliveryError = null;
      }
    } catch {
      run.delivery = "unknown";
      run.deliveryError = "回传结果不确定，不自动重复注入；请查看报告";
    }
    await store.save();
  } finally { await release?.(); }
}
