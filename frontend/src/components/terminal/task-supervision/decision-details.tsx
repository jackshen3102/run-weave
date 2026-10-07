import type { SupervisionDecision } from "@runweave/shared/task-supervision";
export function SupervisionDecisionDetails({
  decision,
}: {
  decision: SupervisionDecision;
}) {
  return (
    <details className="space-y-3 text-xs leading-6 text-slate-400">
      <summary className="cursor-pointer text-sky-400">判定详情</summary>
      <p className="break-all">
        {decision.createdAt} · {decision.model} · {decision.codexVersion} ·{" "}
        {decision.durationMs}ms · 目标版本 {decision.contextRevision}
        <br />
        decision {decision.decisionId} · 投递 {decision.delivery}
      </p>
      <h3>本轮完整最终回复</h3>
      <pre className="whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-900 p-3 text-slate-200">
        {decision.input.currentReply.text}
      </pre>
      <h3>本次输入快照与来源</h3>
      <pre className="whitespace-pre-wrap break-all rounded border border-slate-800 bg-slate-900 p-3">
        {JSON.stringify(decision.input, null, 2)}
      </pre>
    </details>
  );
}
