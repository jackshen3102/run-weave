import type {
  AgentTeamAcceptanceDisposition,
  AgentTeamFindingDisposition,
  AgentTeamRun,
} from "@runweave/shared/agent-team";
import { AgentTeamAcceptanceDecisionCard } from "./terminal-agent-team-acceptance-decision";
import { AgentTeamFindingDecisionCard } from "./terminal-agent-team-finding-decision";
import { AgentTeamAttentionSummary } from "./terminal-agent-team-panel-attention";
import {
  getPendingAgentTeamAcceptanceCases,
  type AgentTeamAttention,
  type AgentTeamControlState,
  type AgentTeamStatusPresentation,
} from "./terminal-agent-team-panel-model";

export function AgentTeamPanelEmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-xs text-slate-500">
      选择一个终端以查看 Agent Team 流程。
    </div>
  );
}

export function AgentTeamPanelHeader({
  run,
  projectId,
  terminalSessionId,
  loading,
  statusPresentation,
}: {
  run: AgentTeamRun | null;
  projectId: string;
  terminalSessionId: string;
  loading: boolean;
  statusPresentation: AgentTeamStatusPresentation | null;
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs font-medium text-slate-300">Agent Team</span>
        {run ? (
          <span
            className={[
              "rounded px-1.5 py-0.5 text-[10px] uppercase",
              statusPresentation?.tone === "danger"
                ? "bg-rose-500/20 text-rose-300"
                : statusPresentation?.tone === "warning"
                  ? "bg-amber-500/20 text-amber-300"
                  : statusPresentation?.tone === "recovering"
                    ? "bg-cyan-500/20 text-cyan-300"
                    : statusPresentation?.tone === "running"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-slate-700 text-slate-300",
            ].join(" ")}
          >
            {statusPresentation?.label}
          </span>
        ) : null}
      </div>

      <div
        className="flex items-center gap-1 border-b border-slate-800 px-3 py-1.5 font-mono text-[10px] text-slate-500"
        data-agent-team-project-id={projectId}
        data-agent-team-terminal-session-id={terminalSessionId}
        data-agent-team-run-id={run?.runId ?? undefined}
      >
        <span
          className="min-w-0 truncate"
          title={`Terminal ${terminalSessionId}`}
        >
          Terminal {formatScopeId(terminalSessionId)}
        </span>
        <span aria-hidden="true">·</span>
        <span
          className="min-w-0 truncate"
          title={run ? `Run ${run.runId}` : undefined}
        >
          {run
            ? `Run ${formatScopeId(run.runId.replace(/^atr_/, ""))}`
            : loading
              ? "正在读取 Run…"
              : "暂无 Run"}
        </span>
      </div>
    </>
  );
}

export function AgentTeamPanelGate({
  run,
  controlState,
  attention,
  busy,
  onDecideFinding,
  onDecideAcceptance,
  onFocusPane,
  onShowAttentionDetails,
}: {
  run: AgentTeamRun | null;
  controlState: AgentTeamControlState | null;
  attention: AgentTeamAttention | null;
  busy: boolean;
  onDecideFinding: (
    disposition: AgentTeamFindingDisposition,
    caseIds: string[],
    reason: string,
  ) => void;
  onDecideAcceptance: (
    caseId: string,
    disposition: AgentTeamAcceptanceDisposition,
    reason: string,
  ) => void;
  onFocusPane: (panelId: string) => void;
  onShowAttentionDetails: (caseId: string) => void;
}) {
  const pendingAcceptanceCase = run
    ? getPendingAgentTeamAcceptanceCases(run)[0]
    : null;

  if (run?.pendingFindingDecision && controlState?.allowsFindingDecision) {
    return (
      <AgentTeamFindingDecisionCard
        key={run.pendingFindingDecision.id}
        run={run}
        busy={busy}
        onDecide={onDecideFinding}
      />
    );
  }
  if (run && controlState?.allowsAcceptanceDecision) {
    return (
      <AgentTeamAcceptanceDecisionCard
        key={[
          run.runId,
          pendingAcceptanceCase?.caseId,
          pendingAcceptanceCase?.latestObservation?.recordedAt,
        ].join(":")}
        run={run}
        busy={busy}
        onDecide={onDecideAcceptance}
      />
    );
  }
  if (
    run &&
    attention &&
    controlState?.kind !== "automatic_recovery" &&
    !controlState?.allowsFrameworkRecovery
  ) {
    return (
      <AgentTeamAttentionSummary
        attention={attention}
        onFocusPane={onFocusPane}
        onShowDetails={onShowAttentionDetails}
      />
    );
  }
  return null;
}

function formatScopeId(value: string): string {
  return value.slice(0, 12);
}
