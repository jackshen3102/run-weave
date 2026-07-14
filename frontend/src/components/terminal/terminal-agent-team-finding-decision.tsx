import { useMemoizedFn } from "ahooks";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type {
  AgentTeamFindingDisposition,
  AgentTeamRun,
} from "@runweave/shared/agent-team";

export function AgentTeamFindingDecisionCard({
  run,
  busy,
  onDecide,
}: {
  run: AgentTeamRun;
  busy: boolean;
  onDecide: (
    disposition: AgentTeamFindingDisposition,
    caseIds: string[],
    reason: string,
  ) => void;
}) {
  const pending = run.pendingFindingDecision;
  const [reason, setReason] = useState("");
  const productCases = run.acceptance.filter(
    (item) =>
      item.sourceCaseId &&
      item.sourceFilePath &&
      !/code review|代码审查|code_review/i.test(item.text),
  );
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>(() => {
    const traceableCaseIds = new Set(productCases.map((item) => item.caseId));
    return pending
      ? (pending.finding.caseImpacts ?? [])
          .map((impact) => impact.caseId)
          .filter((caseId) => traceableCaseIds.has(caseId))
      : [];
  });

  const toggleCase = useMemoizedFn((caseId: string): void => {
    setSelectedCaseIds((current) =>
      current.includes(caseId)
        ? current.filter((item) => item !== caseId)
        : [...current, caseId],
    );
  });
  const submitBlocking = useMemoizedFn(() => {
    onDecide("blocking", selectedCaseIds, reason);
  });
  const submitOutOfScope = useMemoizedFn(() => {
    onDecide("out_of_scope", [], reason);
  });
  const submitWaived = useMemoizedFn(() => {
    onDecide("waived", selectedCaseIds, reason);
  });

  if (!pending) {
    return null;
  }
  const { finding } = pending;
  const reproduction = finding.reproduction;
  const hasReason = Boolean(reason.trim());
  const hasMappedCase = selectedCaseIds.length > 0;

  return (
    <section
      className="mx-3 mt-2 shrink-0 rounded border border-rose-700 bg-rose-950/40 p-2.5"
      aria-label="Finding 范围裁决"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase text-rose-300">
        <span className="flex items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5" /> Finding 范围裁决
        </span>
        <span>{finding.severity}</span>
      </div>
      <div className="mt-1.5 text-xs font-semibold text-rose-100">
        {finding.title}
      </div>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-rose-200">
        {finding.summary}
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-rose-300/80">
        {pending.reason}
      </p>
      <div className="mt-2 rounded border border-slate-700 bg-slate-950/70 p-2 text-[10px] leading-relaxed text-slate-300">
        <div className="font-semibold uppercase text-slate-500">复现场景</div>
        <div className="mt-0.5 font-mono text-sky-300">
          {reproduction?.scenarioId ?? "structural finding"}
        </div>
        {reproduction ? (
          <>
            <div className="mt-1">期望：{reproduction.expected}</div>
            <div>实际：{reproduction.actual}</div>
            <div className="mt-1 text-slate-500">
              {reproduction.steps.join(" → ")}
            </div>
          </>
        ) : null}
      </div>
      <div className="mt-2 text-[10px] font-semibold uppercase text-slate-500">
        映射到可追溯产品 Case
      </div>
      <div className="mt-1 max-h-28 space-y-1 overflow-y-auto">
        {productCases.map((item) => (
          <label
            key={item.caseId}
            className="flex cursor-pointer items-start gap-1.5 rounded border border-slate-700 bg-slate-900/70 p-1.5 text-[10px] text-slate-300"
          >
            <input
              type="checkbox"
              className="mt-0.5"
              checked={selectedCaseIds.includes(item.caseId)}
              onChange={() => toggleCase(item.caseId)}
            />
            <span className="min-w-0">
              <span className="text-slate-200">
                {item.sourceCaseId} · {item.text}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[9px] text-slate-500">
                {item.sourceFilePath} · {item.caseId}
              </span>
            </span>
          </label>
        ))}
      </div>
      <textarea
        className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 focus:border-rose-600"
        rows={2}
        placeholder="填写裁决原因（必填）"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <button
          type="button"
          className="min-h-8 rounded border border-rose-700 px-1 text-[10px] text-rose-100 hover:bg-rose-950/70 disabled:opacity-40"
          disabled={busy || !hasReason || !hasMappedCase}
          onClick={submitBlocking}
        >
          继续修复
        </button>
        <button
          type="button"
          className="min-h-8 rounded border border-sky-700 px-1 text-[10px] text-sky-200 hover:bg-sky-950/50 disabled:opacity-40"
          disabled={busy || !hasReason}
          onClick={submitOutOfScope}
        >
          标记范围外
        </button>
        <button
          type="button"
          className="min-h-8 rounded border border-amber-700 px-1 text-[10px] text-amber-200 hover:bg-amber-950/50 disabled:opacity-40"
          disabled={busy || !hasReason || !hasMappedCase}
          onClick={submitWaived}
        >
          本轮豁免
        </button>
      </div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-slate-500">
        Finding 事实和复现证据始终保留；裁决只改变本轮产品处理结论。
      </p>
    </section>
  );
}
