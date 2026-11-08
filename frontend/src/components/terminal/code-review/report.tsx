import { useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useCodeReviewDetail, useCodeReviews, codeReviewError } from "../../../features/terminal/queries/code-review";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";
import { getCodeReviewArtifact } from "../../../services/terminal/code-review";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { Button } from "../../ui/button";
import { codeReviewStatus } from "./status";
export function CodeReviewReportView() {
  const { scope, apiBase, token } = useTerminalRuntime();
  const sessionId = useTerminalWorkspaceStore((state) => state.activeSessionId);
  const history = useCodeReviews(sessionId, false);
  const target = useTerminalPreviewStore((state) => state.codeReviewTarget);
  const query = useCodeReviewDetail(target?.scope === scope ? target.reviewId : null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const download = useMemoizedFn(async (artifactId: string) => {
    if (!query.data?.report) return;
    try {
      const artifact = query.data.report.artifacts.find((item) => item.artifactId === artifactId)!;
      const blob = await getCodeReviewArtifact(apiBase, token, query.data.run.reviewId, artifactId);
      const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = artifact.path.split("/").at(-1) ?? artifactId; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); setArtifactError(null);
    } catch (error) { setArtifactError(codeReviewError(error)); }
  });
  const value = query.data; const report = value?.report;
  return <div className="h-full flex flex-col gap-4 overflow-y-auto p-4 text-sm text-foreground" data-testid="code-review-report">
    <h2 className="font-semibold">独立代码 Review</h2>
    {(history.data?.runs.length ?? 0) > 1 ? <details><summary>本终端最近的报告</summary>
      <div className="flex flex-col gap-1">{history.data!.runs.map((run) => <Button key={run.reviewId} variant="ghost" size="sm"
        onClick={() => useTerminalPreviewStore.getState().openCodeReview({ scope, reviewId: run.reviewId })}>
        {new Date(run.createdAt).toLocaleString()} · {codeReviewStatus(run)}
      </Button>)}</div>
    </details> : null}
    {query.error ? <p role="alert">{codeReviewError(query.error)}</p> : null}
    {!value ? <p>{query.isFetching ? "读取报告…" : "从来源终端选择一份报告"}</p> : <>
      <p>{codeReviewStatus(value.run)}</p>
      <p>第 {value.run.round ?? 1} 轮审查</p>
      {value.run.deliveryError ? <p className="text-muted-foreground">{value.run.deliveryError}</p> : null}
      <p className="break-all text-xs text-muted-foreground">{value.run.createdAt} · {value.snapshot?.fingerprint}</p>
      {value.run.stale ? <p className="text-muted-foreground">审查期间代码已变化，结论仅对应原快照。</p> : null}
      {report ? <>
        <p className="whitespace-pre-wrap">{report.summary}</p>
        <p>{report.coverageComplete ? "已声明覆盖完整，仍需核对证据" : "覆盖存在缺口"} · {report.findings.length} 个问题</p>
        {report.findings.map((finding, index) => <article key={index} className="flex flex-col gap-1 rounded border border-border p-3">
          <h3>{finding.severity} · {finding.title}</h3>
          <p className="break-all text-xs text-muted-foreground">{finding.path}:{finding.lineStart}–{finding.lineEnd} · {finding.changeKind}/{finding.side} · {finding.basis}</p>
          <p className="whitespace-pre-wrap">{finding.impact}</p>
          {finding.evidenceRefs.map((id) => <Button key={id} variant="link" size="sm" onClick={() => void download(id)}>{id}</Button>)}
        </article>)}
        <h3>验证记录</h3>
        {report.checks.map((check, index) => <div key={index} className="rounded border border-border p-2">
          <p>{check.description} · {check.status}</p><p className="text-xs text-muted-foreground">{check.environment}</p><p className="whitespace-pre-wrap">{check.observedResult}</p>
          {check.evidenceRefs.map((id) => <Button key={id} variant="link" size="sm" onClick={() => void download(id)}>{id}</Button>)}
        </div>)}
        {report.limitations.map((item, index) => <p key={index} className="whitespace-pre-wrap text-muted-foreground">{item}</p>)}
        <p>资源清理：{report.cleanup}</p>
        <details><summary>受审文件（{report.reviewedChanges.length}）</summary>{report.reviewedChanges.map((entry) => <p key={`${entry.changeKind}:${entry.path}`} className="break-all">{entry.changeKind} · {entry.path}</p>)}</details>
      </> : <p>报告尚未完成。{value.snapshot?.omissions.join("；")}</p>}
      <p className="text-xs text-muted-foreground">Review 只评审代码，不表示符合原对话需求或可发布；不自动授予修复、提交和外部操作权限。</p>
    </>}
    {artifactError ? <p role="alert">{artifactError}</p> : null}
  </div>;
}
