import { useMemoizedFn } from "ahooks";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type {
  AgentTeamAcceptanceDisposition,
  AgentTeamRun,
} from "@runweave/shared/agent-team";
import { getPendingAgentTeamAcceptanceCases } from "./terminal-agent-team-panel-model";

export function AgentTeamAcceptanceDecisionCard({
  run,
  busy,
  onDecide,
}: {
  run: AgentTeamRun;
  busy: boolean;
  onDecide: (
    caseId: string,
    disposition: AgentTeamAcceptanceDisposition,
    reason: string,
  ) => void;
}) {
  const [reason, setReason] = useState("");
  const acceptanceCase = getPendingAgentTeamAcceptanceCases(run)[0];
  const submit = useMemoizedFn(
    (disposition: AgentTeamAcceptanceDisposition): void => {
      if (!acceptanceCase) return;
      onDecide(acceptanceCase.caseId, disposition, reason.trim());
    },
  );

  if (!acceptanceCase?.latestObservation) {
    return null;
  }
  const environmentSkip =
    acceptanceCase.latestObservation.outcome === "skipped" &&
    acceptanceCase.skip?.code === "environment";
  const hasReason = Boolean(reason.trim());

  return (
    <section
      className="mx-3 mt-2 shrink-0 rounded border border-amber-700 bg-amber-950/35 p-2.5"
      aria-label="验收 Case 人工裁决"
      aria-live="polite"
    >
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5" /> 验收 Case 等待人工裁决
      </div>
      <div className="mt-1.5 font-mono text-[10px] text-slate-500">
        {acceptanceCase.sourceCaseId ?? acceptanceCase.caseId}
      </div>
      <div className="mt-0.5 text-xs text-amber-100">
        {acceptanceCase.text}
      </div>
      <div className="mt-2 rounded border border-slate-700 bg-slate-950/70 p-2 text-[10px] leading-relaxed text-slate-300">
        <div className="font-semibold text-amber-300">
          {acceptanceCase.latestObservation.outcome === "skipped"
            ? "模型观察：跳过"
            : "模型观察：未通过"}
        </div>
        <div className="mt-0.5">
          {acceptanceCase.skip?.detail ??
            acceptanceCase.resultSummary ??
            acceptanceCase.skipReason ??
            "当前 observation 尚未解决。"}
        </div>
      </div>
      <textarea
        className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-600"
        rows={2}
        placeholder="填写裁决原因（必填）"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className={environmentSkip ? "mt-2 grid grid-cols-2 gap-1.5" : "mt-2"}>
        {environmentSkip ? (
          <button
            type="button"
            className="min-h-8 rounded border border-amber-600 bg-amber-600 px-1 text-[10px] font-semibold text-slate-950 hover:bg-amber-500 disabled:opacity-40"
            disabled={busy || !hasReason}
            onClick={() => submit("accepted_environment_skip")}
          >
            确认环境问题并跳过
          </button>
        ) : null}
        <button
          type="button"
          className="min-h-8 rounded border border-slate-600 px-1 text-[10px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          disabled={busy || !hasReason}
          onClick={() => submit("invalid_case")}
        >
          标记 Case 不适用
        </button>
      </div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-slate-500">
        原始 observation 和证据会保留；人工裁决只解除当前 Run 的 Case 义务。
      </p>
    </section>
  );
}
