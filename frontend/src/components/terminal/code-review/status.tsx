import type { CodeReviewRun } from "@runweave/shared/terminal/code-review";
import { useMemoizedFn } from "ahooks";
import { useCodeReviewActionState, useCodeReviews } from "../../../features/terminal/queries/code-review";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { Button } from "../../ui/button";
export function codeReviewStatus(run: CodeReviewRun): string {
  if (run.error) return run.error.message;
  if (run.phase === "completed") {
    const delivery = { not_ready: "", pending: "等待回传", writing: "正在回传", written: "已回传", target_changed: "来源已变化", unavailable: "仅展示报告", unknown: "回传未确认" }[run.delivery];
    return `审查完成 · ${run.findingCount ?? 0} 个问题 · ${delivery}${run.stale ? " · 代码已变化" : ""}`;
  }
  return { preparing: "准备审查", starting: "启动审查终端", reviewing: "正在审查", blocked: "审查已阻塞", failed: "审查失败", cancelled: "审查已中断" }[run.phase];
}
export function CodeReviewStatus({ sessionId }: { sessionId: string | null }) {
  const query = useCodeReviews(sessionId);
  const action = useCodeReviewActionState(sessionId);
  const { scope } = useTerminalRuntime();
  const run = query.data?.runs[0];
  const openReport = useMemoizedFn(() => { if (run) useTerminalPreviewStore.getState().openCodeReview({ scope, reviewId: run.reviewId }); });
  const openTerminal = useMemoizedFn(() => {
    if (run?.reviewerTerminalId) useTerminalWorkspaceStore.getState().setActiveSessionId(run.reviewerTerminalId);
  });
  if (!run && !action?.pending && !action?.error) return null;
  const label = action?.pending ? "准备审查" : action?.error ?? (run ? codeReviewStatus(run) : "");
  return <div role="status" data-testid="code-review-status" className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1 text-xs text-foreground">
    <span className="min-w-0 flex-1 truncate" title={label}>{label}{query.isError && run ? " · 状态更新失败" : ""}</span>
    {run?.deliveryError ? <span className="max-w-40 truncate text-muted-foreground" title={run.deliveryError}>{run.deliveryError}</span> : null}
    {run ? <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={openReport}>查看报告</Button> : null}
    {run?.reviewerTerminalId ? <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={openTerminal}>评审终端</Button> : null}
  </div>;
}
