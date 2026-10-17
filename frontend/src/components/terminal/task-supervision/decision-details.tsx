import { SupervisionAssessmentDetails } from "./assessment";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { getSupervisionDecision } from "../../../services/task-supervision";
import type {
  SupervisionDecisionDetail,
  SupervisionDecisionSummary,
} from "@runweave/shared/task-supervision";
export function SupervisionDecisionDetails({
  decision,
  watchId,
}: {
  decision: SupervisionDecisionSummary;
  watchId: string;
}) {
  const { apiBase, token } = useTerminalRuntime();
  const [detail, setDetail] = useState<SupervisionDecisionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = useMemoizedFn(async (open: boolean) => {
    if (!open || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setError(null);
    try {
      const result = await getSupervisionDecision(
        apiBase,
        token,
        watchId,
        decision.decisionId,
        controller.signal,
      );
      if (!controller.signal.aborted) setDetail(result);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "读取详情失败");
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  });
  return (
    <details
      onToggle={(event) => void load(event.currentTarget.open)}
      className="space-y-3 text-xs leading-6 text-slate-400"
    >
      <summary className="cursor-pointer text-sky-400">判定详情</summary>
      <p className="break-all">
        {decision.createdAt} · {decision.model} · {decision.codexVersion} ·{" "}
        {decision.durationMs}ms · {decision.goalVersion ? `目标 v${decision.goalVersion}` : "旧版目标"} · 上下文 {decision.contextRevision}
        <br />
        decision {decision.decisionId} · 投递 {decision.delivery}
      </p>
      {error && <p role="status">{error}</p>}
      {!detail && !error && <p>正在读取判断依据…</p>}
      {detail && (
        <>
          <SupervisionAssessmentDetails assessment={detail.assessment} />
          {detail.input.goalDefinition && <section className="space-y-2 rounded border border-slate-800 p-3"><h3>当时采用的目标 · v{detail.input.goalDefinition.version}</h3><p className="whitespace-pre-wrap break-words text-slate-200">{detail.input.goalDefinition.objective}</p><h4>完成条件</h4><p className="whitespace-pre-wrap break-words">{detail.input.goalDefinition.completionCriteria}</p>{detail.input.goalDefinition.constraints && <><h4>范围与约束</h4><p className="whitespace-pre-wrap break-words">{detail.input.goalDefinition.constraints}</p></>}</section>}
          <h3>本轮完整最终回复</h3>
          <pre className="whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-900 p-3 text-slate-200">
            {detail.input.currentReply.text}
          </pre>
          <h3>本次输入快照与来源</h3>
          <pre className="whitespace-pre-wrap break-all rounded border border-slate-800 bg-slate-900 p-3">
            {JSON.stringify(detail.input, null, 2)}
          </pre>
        </>
      )}
    </details>
  );
}
