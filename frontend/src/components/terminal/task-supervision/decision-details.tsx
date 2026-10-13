import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { getSupervisionDecision } from "../../../services/task-supervision";
import type {
  SupervisionDecision,
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
  const [detail, setDetail] = useState<SupervisionDecision | null>(null);
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
        {decision.durationMs}ms · 目标版本 {decision.contextRevision}
        <br />
        decision {decision.decisionId} · 投递 {decision.delivery}
      </p>
      {error && <p role="status">{error}</p>}
      {!detail && !error && <p>正在读取判断依据…</p>}
      {detail && (
        <>
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
