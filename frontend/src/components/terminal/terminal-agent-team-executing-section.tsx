import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import {
  resolveAgentTeamAcceptanceDecision,
  type AgentTeamFrameworkRepairRecoveryStatus,
  type AgentTeamRun,
} from "@runweave/shared/agent-team";
import { Button } from "../ui/button";
import {
  getAgentTeamCaseElementId,
  ROLE_LABEL,
  type AgentTeamControlState,
} from "./terminal-agent-team-panel-model";
import { AcceptanceEvidenceDetails } from "./terminal-agent-team-panel-details";
import { formatVerificationSource } from "./terminal-agent-team-panel-sections";
import { ReviewCheckpointStatus } from "./terminal-agent-team-review-checkpoint-status";

export function ExecutingSection({
  apiBase,
  token,
  projectId,
  run,
  controlState,
  frameworkRecovery,
  busy,
  onRetry,
  onContinueFrameworkRepair,
  onRerunFrameworkRepair,
  onAuthExpired,
}: {
  apiBase: string;
  token: string;
  projectId: string;
  run: AgentTeamRun;
  controlState: AgentTeamControlState;
  frameworkRecovery: AgentTeamFrameworkRepairRecoveryStatus | null;
  busy: boolean;
  onRetry: () => void;
  onContinueFrameworkRepair: () => void;
  onRerunFrameworkRepair: () => void;
  onAuthExpired?: () => void;
}) {
  const { loop, acceptance } = run;
  const ratio =
    loop.maxNoProgress > 0 ? loop.noProgressCount / loop.maxNoProgress : 0;
  const level = loop.escalated ? "escalated" : ratio >= 0.66 ? "warn" : "ok";

  return (
    <div className="space-y-3">
      <ExecutingHeader run={run} />
      {controlState.kind === "automatic_recovery" ? (
        <AutomaticRecoveryCard run={run} />
      ) : null}
      {controlState.allowsFrameworkRecovery ? (
        <FrameworkRepairCard
          recovery={frameworkRecovery}
          busy={busy}
          onContinue={onContinueFrameworkRepair}
          onRerun={onRerunFrameworkRepair}
        />
      ) : null}
      {run.reviewCheckpoint ? <ReviewCheckpointStatus run={run} /> : null}
      <FindingDecisionsCard run={run} />
      <LoopProgressCard run={run} level={level} />
      <RunStatusNotice
        run={run}
        controlState={controlState}
        busy={busy}
        onRetry={onRetry}
      />
      <AcceptanceEvidenceList
        apiBase={apiBase}
        token={token}
        projectId={projectId}
        run={run}
        acceptance={acceptance}
        onAuthExpired={onAuthExpired}
      />
      <RunLogList logs={run.logs} />
    </div>
  );
}

function AutomaticRecoveryCard({ run }: { run: AgentTeamRun }) {
  const role = run.activeWorkerRole
    ? ROLE_LABEL[run.activeWorkerRole]
    : "Worker";
  return (
    <div
      className="space-y-2 rounded border border-cyan-800 bg-cyan-950/30 p-2"
      aria-label="正在自动恢复"
      aria-live="polite"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-200">
        <Loader2 className="h-4 w-4 animate-spin" /> 正在自动恢复
      </div>
      <p className="text-[11px] leading-relaxed text-cyan-100/90">
        正在等待同一 {role} thread 补交结构化结果；恢复期间无需人工操作。
      </p>
    </div>
  );
}

function FrameworkRepairCard({
  recovery,
  busy,
  onContinue,
  onRerun,
}: {
  recovery: AgentTeamFrameworkRepairRecoveryStatus | null;
  busy: boolean;
  onContinue: () => void;
  onRerun: () => void;
}) {
  return (
    <div className="space-y-2 rounded border border-amber-800 bg-amber-950/35 p-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
        <AlertTriangle className="h-4 w-4" /> 需要恢复现场
      </div>
      <p className="text-[11px] leading-relaxed text-amber-100">
        {recovery?.reason ?? "正在读取框架修复现场…"}
      </p>
      <div className="space-y-0.5 text-[10px] text-amber-200/80">
        <div>
          Backend 重启：{recovery?.backendRestarted ? "已检测到" : "尚未检测到"}
        </div>
        <div>
          继续条件：
          {recovery?.canContinue
            ? "原 Worker pane 可继续"
            : (recovery?.continueBlocker?.message ?? "正在检查")}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !recovery?.canContinue}
          onClick={onContinue}
        >
          继续原 Run
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !recovery}
          onClick={onRerun}
        >
          <RotateCcw className="h-4 w-4" /> 重新运行
        </Button>
      </div>
    </div>
  );
}

function ExecutingHeader({ run }: { run: AgentTeamRun }) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-semibold uppercase text-slate-400">
        Loop 状态
      </h3>
      <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] uppercase text-slate-500">
        {(run.runKind ?? "primary") === "verification_fixture"
          ? "Fixture"
          : run.activeWorkerRole
            ? ROLE_LABEL[run.activeWorkerRole]
            : "Observe Only"}
      </span>
    </div>
  );
}

function FindingDecisionsCard({ run }: { run: AgentTeamRun }) {
  const decisions = run.findingDecisions ?? [];
  if (decisions.length === 0) {
    return null;
  }
  return (
    <div className="rounded border border-sky-900 bg-sky-950/25 p-2 text-[10px] text-sky-200">
      <div className="font-semibold uppercase text-sky-400">
        Finding 裁决记录
      </div>
      {decisions.slice(-3).map((decision) => (
        <div key={decision.id} className="mt-1 break-words">
          <span className="font-mono">{decision.invariantKey}</span> ·{" "}
          {formatFindingDisposition(decision.disposition)}
          {decision.caseIds.length > 0
            ? ` · ${decision.caseIds.join(", ")}`
            : ""}
          <span className="block text-sky-100/80">
            {decision.finding.severity} · {decision.finding.title}
          </span>
          <span className="block text-sky-300/60">{decision.reason}</span>
        </div>
      ))}
    </div>
  );
}

function LoopProgressCard({
  run,
  level,
}: {
  run: AgentTeamRun;
  level: "escalated" | "warn" | "ok";
}) {
  const { loop } = run;
  return (
    <div
      className={[
        "rounded border p-2",
        level === "escalated"
          ? "border-rose-800 bg-rose-950/40"
          : level === "warn"
            ? "border-amber-800 bg-amber-950/30"
            : "border-slate-800 bg-slate-900/40",
      ].join(" ")}
    >
      <div className="flex items-center justify-between text-xs text-slate-300">
        <span>轮次</span>
        <span>round {loop.round}</span>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-300">
        <span>无进展</span>
        <span>
          {loop.noProgressCount} / {loop.maxNoProgress}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1">
        {Array.from({ length: loop.maxNoProgress }).map((_, index) => (
          <span
            key={index}
            className={[
              "h-1.5 flex-1 rounded",
              index < loop.noProgressCount
                ? level === "escalated"
                  ? "bg-rose-500"
                  : "bg-amber-400"
                : "bg-slate-700",
            ].join(" ")}
          />
        ))}
      </div>
    </div>
  );
}

function RunStatusNotice({
  run,
  controlState,
  busy,
  onRetry,
}: {
  run: AgentTeamRun;
  controlState: AgentTeamControlState;
  busy: boolean;
  onRetry: () => void;
}) {
  if (controlState.kind === "scope_decision") {
    return (
      <div className="rounded border border-rose-800 bg-rose-950/40 p-2 text-[11px] text-rose-200">
        Loop 已暂停。请在顶部完成 Finding
        范围裁决；这里不会提供通用“人工完成”入口。
      </div>
    );
  }
  if (
    controlState.kind === "recovery_required" &&
    !controlState.allowsFrameworkRecovery
  ) {
    return (
      <div className="rounded border border-amber-800 bg-amber-950/35 p-2 text-[11px] text-amber-100">
        <div className="font-semibold text-amber-200">需要恢复现场</div>
        <p className="mt-1 leading-relaxed">
          {run.loop.lastReason ?? "Run 已暂停，请先恢复运行现场。"}
        </p>
      </div>
    );
  }
  if (run.status === "done") {
    return (
      <div className="rounded border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-300">
        Loop 已完成，worker pane 已冻结。
      </div>
    );
  }
  if (run.status === "cancelled") {
    const cleanup = run.fixtureResourceCleanup;
    return (
      <div className="rounded border border-slate-700 bg-slate-900/50 p-2 text-xs text-slate-300">
        Fixture 已取消；Run 与 outbox 历史保留。
        {cleanup?.status === "completed"
          ? " owned terminal/pane 已按资源账本回收。"
          : cleanup?.status === "failed"
            ? ` 资源回收失败：${cleanup.errors.join("；")}`
            : " 资源回收尚未执行。"}
      </div>
    );
  }
  if (run.status !== "failed") {
    return null;
  }
  return (
    <div className="space-y-2 rounded border border-rose-800 bg-rose-950/40 p-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
        <AlertTriangle className="h-4 w-4" /> Agent Team 执行失败
      </div>
      <p className="text-[11px] text-rose-200">
        {run.logs.at(-1) ?? "Agent Team 未能完成当前 Run。"}
      </p>
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={busy}
        onClick={onRetry}
      >
        <RotateCcw className="h-4 w-4" /> 修改参数并重试
      </Button>
    </div>
  );
}

function AcceptanceEvidenceList({
  apiBase,
  token,
  projectId,
  run,
  acceptance,
  onAuthExpired,
}: {
  apiBase: string;
  token: string;
  projectId: string;
  run: AgentTeamRun;
  acceptance: AgentTeamRun["acceptance"];
  onAuthExpired?: () => void;
}) {
  const passed = acceptance.filter((item) => item.status === "pass").length;
  const failed = acceptance.filter((item) => item.status === "fail").length;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-400">
        <span>验收用例 + 证据</span>
        <span className="text-[10px] text-slate-500">
          {passed}✓{failed > 0 ? ` ${failed}✗` : ""}
        </span>
      </div>
      <div className="mb-1 text-[10px] text-sky-300">
        {formatVerificationSource(run)}
      </div>
      <div className="space-y-1.5">
        {acceptance.map((item) => (
          <AcceptanceEvidenceItem
            key={item.caseId}
            apiBase={apiBase}
            token={token}
            projectId={projectId}
            run={run}
            item={item}
            onAuthExpired={onAuthExpired}
          />
        ))}
      </div>
    </div>
  );
}

function AcceptanceEvidenceItem({
  apiBase,
  token,
  projectId,
  run,
  item,
  onAuthExpired,
}: {
  apiBase: string;
  token: string;
  projectId: string;
  run: AgentTeamRun;
  item: AgentTeamRun["acceptance"][number];
  onAuthExpired?: () => void;
}) {
  const decision = resolveAgentTeamAcceptanceDecision(run, item);
  return (
    <div
      id={getAgentTeamCaseElementId(run.runId, item.caseId)}
      tabIndex={-1}
      className={[
        "rounded border px-2 py-1.5 text-[11px] outline-none focus:ring-1 focus:ring-amber-400",
        item.status === "pass"
          ? "border-emerald-900 bg-emerald-950/30"
          : item.status === "fail"
            ? "border-rose-900 bg-rose-950/30"
            : "border-slate-800 bg-slate-900/40",
      ].join(" ")}
    >
      <div className="flex items-start gap-1.5">
        <span className={getAcceptanceStatusClassName(item.status)}>
          {getAcceptanceStatusMarker(item.status)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] text-slate-500">
            {item.sourceCaseId ?? item.caseId}
          </div>
          <div className="whitespace-pre-wrap break-words text-slate-300">
            {item.text}
          </div>
          {item.sourceFilePath ? (
            <div className="mt-0.5 text-[10px] text-slate-500">
              来源：{item.sourceFilePath}
            </div>
          ) : null}
          {item.skipReason ? (
            <div className="mt-0.5 text-[10px] text-slate-500">
              跳过：{item.skipReason}
            </div>
          ) : null}
          {decision ? (
            <div className="mt-1 rounded border border-amber-800/70 bg-amber-950/30 px-1.5 py-1 text-[10px] text-amber-200">
              人工裁决：
              {decision.disposition === "accepted_environment_skip"
                ? "确认环境问题并跳过"
                : "Case 不适用"}
              <span className="block text-amber-300/70">{decision.reason}</span>
            </div>
          ) : null}
          <AcceptanceEvidenceDetails
            apiBase={apiBase}
            token={token}
            projectId={projectId}
            status={item.status}
            summary={item.resultSummary}
            evidence={item.evidence}
            onAuthExpired={onAuthExpired}
          />
          {item.status === "fail" && item.bouncedToPanelId ? (
            <div className="mt-0.5 text-[10px] text-amber-400">
              → 已抛回 code pane 修复
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RunLogList({ logs }: { logs: string[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-slate-400">Log</div>
      <div className="space-y-0.5 rounded border border-slate-800 bg-slate-950/60 p-2 font-mono text-[10px] text-slate-400">
        {logs
          .slice()
          .reverse()
          .map((line, index) => (
            <div key={`${index}-${line}`}>{line}</div>
          ))}
      </div>
    </div>
  );
}

function formatFindingDisposition(
  disposition: "blocking" | "out_of_scope" | "waived",
): string {
  if (disposition === "blocking") {
    return "继续修复";
  }
  return disposition === "out_of_scope" ? "范围外" : "本轮豁免";
}

function getAcceptanceStatusClassName(
  status: AgentTeamRun["acceptance"][number]["status"],
): string {
  if (status === "pass") {
    return "text-emerald-400";
  }
  return status === "fail" ? "text-rose-400" : "text-slate-500";
}

function getAcceptanceStatusMarker(
  status: AgentTeamRun["acceptance"][number]["status"],
): string {
  if (status === "pass") {
    return "✓";
  }
  return status === "fail" ? "✗" : "•";
}
