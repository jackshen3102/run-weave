import type { CodeReviewRun } from "@runweave/shared/terminal/code-review";
import { useMemoizedFn } from "ahooks";
import { codeReviewError, useCloseCodeReview, useCodeReviewActionState, useCodeReviews } from "../../../features/terminal/queries/code-review";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { Button } from "../../ui/button";
export function codeReviewStatus(run: CodeReviewRun): string {
  if (run.caseStatus === "closed") return "审查已结束 · 用户结束";
  if (run.caseStatus === "passed" && (run.findingCount ?? 0) > 0) return `审查事项已完成 · 本轮发现 ${run.findingCount} 个问题`;
  if (run.error) return run.error.message;
  if (run.phase === "completed") {
    const delivery = { not_ready: "", skipped: "无需回传", pending: "等待回传", writing: "正在回传", written: "已回传", target_changed: "来源已变化", unavailable: "仅展示报告", unknown: "回传未确认" }[run.delivery];
    return `${run.findingCount === 0 ? "审查完成 · 未发现 Bug" : `待修复／复审 · ${run.findingCount ?? 0} 个问题`} · ${delivery}${run.stale ? " · 代码已变化" : ""}`;
  }
  return { preparing: "准备审查", starting: "启动审查终端", reviewing: "正在审查", blocked: "审查已阻塞", failed: "审查失败", cancelled: "审查已中断" }[run.phase];
}
export function CodeReviewStatus({ sessionId }: { sessionId: string | null }) {
  const query = useCodeReviews(sessionId);
  const action = useCodeReviewActionState(sessionId);
  const close = useCloseCodeReview(sessionId);
  const { scope } = useTerminalRuntime();
  const run = query.data?.runs[0];
  const openReport = useMemoizedFn(() => { if (run) useTerminalPreviewStore.getState().openCodeReview({ scope, reviewId: run.reviewId }); });
  const openTerminal = useMemoizedFn(() => {
    if (run?.reviewerTerminalId) useTerminalWorkspaceStore.getState().setActiveSessionId(run.reviewerTerminalId);
  });
  const closeError = close.isError && close.variables === run?.reviewId ? codeReviewError(close.error) : null;
  const ended = run?.caseStatus === "closed" || run?.caseStatus === "passed";
  if ((!run || ended) && !action?.pending && !action?.error && !closeError) return null;
  const label = action?.pending ? "准备审查" : action?.error ?? closeError ?? (run ? codeReviewStatus(run) : "");
  const canClose = run && !ended && !["preparing", "starting", "reviewing"].includes(run.phase) && !["pending", "writing"].includes(run.delivery);
  return <div role="status" data-testid="code-review-status" className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1 text-xs text-foreground">
    <span className="min-w-0 flex-1 truncate" title={label}>{label}{query.isError && run ? " · 状态更新失败" : ""}</span>
    {run?.deliveryError ? <span className="max-w-40 truncate text-muted-foreground" title={run.deliveryError}>{run.deliveryError}</span> : null}
    {run ? <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={openReport}>查看报告</Button> : null}
    {run?.reviewerTerminalId ? <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={openTerminal}>评审终端</Button> : null}
    {canClose ? <Button variant="ghost" size="sm" className="h-7 text-xs" aria-label="结束审查事项" title="结束审查事项，保留历史报告" disabled={close.isPending}
      onClick={() => close.mutate(run.reviewId)}>×</Button> : null}
  </div>;
}
