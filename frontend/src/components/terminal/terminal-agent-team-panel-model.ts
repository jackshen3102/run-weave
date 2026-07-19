import {
  resolveAgentTeamAcceptanceDecision,
  resolveAgentTeamAcceptanceObservedOutcome,
  type AgentTeamAcceptanceCase,
  type AgentTeamRepairCycle,
  type AgentTeamRun,
  type AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";

export const AGENT_TEAM_POLL_INTERVAL_MS = 4000;

export const PHASE_LABEL: Record<AgentTeamRun["phase"], string> = {
  intake: "任务接收",
  proposal: "拆分提案",
  executing: "执行观测",
};

export const ROLE_LABEL: Record<AgentTeamWorkerRole, string> = {
  code: "code",
  code_review: "code_review",
  behavior_verify: "behavior_verify",
};

export const ROLE_CYCLE: AgentTeamWorkerRole[] = [
  "code",
  "code_review",
  "behavior_verify",
];

export interface WorkerDraft {
  role: AgentTeamWorkerRole;
  intent: string;
}

export type AgentTeamAttentionTone = "warning" | "danger";

export interface AgentTeamAttention {
  kind: "human" | "review" | "case" | "run_failure";
  tone: AgentTeamAttentionTone;
  title: string;
  severity: string | null;
  summary: string;
  meta: string;
  issueCount: number;
  caseId: string | null;
  panelId: string | null;
  panelLabel: string | null;
}

export interface AgentTeamStatusPresentation {
  label: string;
  tone: "neutral" | "running" | "recovering" | AgentTeamAttentionTone;
}

export type AgentTeamControlStateKind =
  | "normal"
  | "automatic_recovery"
  | "recovery_required"
  | "scope_decision"
  | "acceptance_decision";

export interface AgentTeamControlState extends AgentTeamStatusPresentation {
  kind: AgentTeamControlStateKind;
  allowsFrameworkRecovery: boolean;
  allowsFindingDecision: boolean;
  allowsAcceptanceDecision: boolean;
}

export function getAgentTeamAttention(
  run: AgentTeamRun,
): AgentTeamAttention | null {
  const reviewCycles = run.loop.repairCycles
    .filter((cycle) => cycle.sourceRole === "code_review")
    .sort(compareReviewSeverity);
  const reviewCaseIds = new Set(reviewCycles.flatMap((cycle) => cycle.caseIds));
  const failedCases = run.acceptance.filter(
    (item) => item.status === "fail" && !reviewCaseIds.has(item.caseId),
  );
  const issueCount = reviewCycles.length + failedCases.length;
  const primaryIssue = reviewCycles[0]
    ? buildReviewAttention(run, reviewCycles[0], issueCount)
    : failedCases[0]
      ? buildCaseAttention(run, failedCases[0], issueCount)
      : null;

  if (run.status === "need_human" || run.loop.escalated) {
    const target = primaryIssue ? null : getActivePanel(run);
    return {
      kind: "human",
      tone: "danger",
      title: "需要恢复现场",
      severity: "阻断",
      summary:
        run.loop.lastReason ??
        primaryIssue?.summary ??
        "Agent Team 已暂停，需要恢复运行现场。",
      meta: primaryIssue
        ? `阻断来源：${primaryIssue.title}${primaryIssue.caseId ? ` · ${primaryIssue.caseId}` : ""}`
        : "Loop 已暂停",
      issueCount: Math.max(issueCount, 1),
      caseId: primaryIssue?.caseId ?? null,
      panelId: primaryIssue?.panelId ?? target?.panelId ?? null,
      panelLabel:
        primaryIssue?.panelLabel ??
        (target ? formatPanelLabel(target.role) : null),
    };
  }

  if (run.status === "failed") {
    const target = primaryIssue ? null : getActivePanel(run);
    return {
      kind: "run_failure",
      tone: "danger",
      title: "Agent Team 执行失败",
      severity: "失败",
      summary:
        primaryIssue?.summary ??
        run.logs.at(-1) ??
        "Agent Team 未能完成当前 Run。",
      meta: primaryIssue?.meta ?? "Run 已停止",
      issueCount: Math.max(issueCount, 1),
      caseId: primaryIssue?.caseId ?? null,
      panelId: primaryIssue?.panelId ?? target?.panelId ?? null,
      panelLabel:
        primaryIssue?.panelLabel ??
        (target ? formatPanelLabel(target.role) : null),
    };
  }

  return primaryIssue;
}

export function getAgentTeamStatusPresentation(
  run: AgentTeamRun,
  attention: AgentTeamAttention | null,
): AgentTeamStatusPresentation {
  const controlState = getAgentTeamControlState(run);
  if (controlState.kind !== "normal") {
    return controlState;
  }
  if (run.status === "failed") {
    return { label: "失败", tone: "danger" };
  }
  if (run.status === "cancelled") {
    return { label: "已取消 fixture", tone: "neutral" };
  }
  if (run.status === "done" && attention) {
    return { label: "人工结束 · 有遗留", tone: "warning" };
  }
  if (
    run.status === "done" &&
    ((run.findingDecisions ?? []).some(
      (decision) => decision.disposition !== "blocking",
    ) ||
      (run.acceptanceDecisions ?? []).length > 0)
  ) {
    return { label: "已完成 · 有裁决", tone: "warning" };
  }
  if (run.status === "done") {
    return { label: "已完成", tone: "neutral" };
  }
  if (run.status === "running") {
    return { label: PHASE_LABEL[run.phase], tone: "running" };
  }
  return { label: PHASE_LABEL[run.phase], tone: "neutral" };
}

export function getAgentTeamControlState(
  run: AgentTeamRun,
): AgentTeamControlState {
  if (run.pendingFindingDecision) {
    return {
      kind: "scope_decision",
      label: "需要范围裁决",
      tone: "danger",
      allowsFrameworkRecovery: false,
      allowsFindingDecision: true,
      allowsAcceptanceDecision: false,
    };
  }
  if (
    run.status === "need_human" &&
    run.frameworkRepair?.result !== "blocked" &&
    getPendingAgentTeamAcceptanceCases(run).length > 0
  ) {
    return {
      kind: "acceptance_decision",
      label: "需要 Case 裁决",
      tone: "warning",
      allowsFrameworkRecovery: false,
      allowsFindingDecision: false,
      allowsAcceptanceDecision: true,
    };
  }
  if (run.status === "need_human" || run.loop.escalated) {
    return {
      kind: "recovery_required",
      label: "需要恢复现场",
      tone: "warning",
      allowsFrameworkRecovery: run.frameworkRepair?.result === "blocked",
      allowsFindingDecision: false,
      allowsAcceptanceDecision: false,
    };
  }
  if (
    run.status === "running" &&
    (run.activeWorkerDispatch?.protocolCorrectionAttempt ?? 0) > 0
  ) {
    return {
      kind: "automatic_recovery",
      label: "正在自动恢复",
      tone: "recovering",
      allowsFrameworkRecovery: false,
      allowsFindingDecision: false,
      allowsAcceptanceDecision: false,
    };
  }
  return {
    kind: "normal",
    label: PHASE_LABEL[run.phase],
    tone: run.status === "running" ? "running" : "neutral",
    allowsFrameworkRecovery: false,
    allowsFindingDecision: false,
    allowsAcceptanceDecision: false,
  };
}

export function getPendingAgentTeamAcceptanceCases(
  run: AgentTeamRun,
): AgentTeamAcceptanceCase[] {
  return run.acceptance.filter(
    (item) =>
      Boolean(item.sourceCaseId && item.sourceFilePath) &&
      !/code review|代码审查|code_review/i.test(item.text) &&
      resolveAgentTeamAcceptanceObservedOutcome(item) !== "pending" &&
      resolveAgentTeamAcceptanceObservedOutcome(item) !== "pass" &&
      !resolveAgentTeamAcceptanceDecision(run, item),
  );
}

export function isAgentTeamRunActive(run: AgentTeamRun): boolean {
  return !["done", "failed", "cancelled"].includes(run.status);
}

export function getAgentTeamCaseElementId(
  runId: string,
  caseId: string,
): string {
  return `agent-team-case-${encodeURIComponent(runId)}-${encodeURIComponent(caseId)}`;
}

function buildReviewAttention(
  run: AgentTeamRun,
  cycle: AgentTeamRepairCycle,
  issueCount: number,
): AgentTeamAttention {
  const bouncedPanelId = getBouncedPanelId(run, cycle.caseIds);
  const target =
    getPanelById(run, bouncedPanelId) ?? getPanelByRole(run, "code");
  return {
    kind: "review",
    tone: "warning",
    title: "Review 未通过",
    severity: getFindingSeverity(cycle.lastFailureSummary),
    summary:
      stripFindingSeverity(cycle.lastFailureSummary) || cycle.invariant.trim(),
    meta: `${formatCaseIds(cycle.caseIds, "Review 阻断")}${formatPanelMeta(target, Boolean(bouncedPanelId))}`,
    issueCount,
    caseId: cycle.caseIds[0] ?? null,
    panelId: target?.panelId ?? null,
    panelLabel: target ? formatPanelLabel(target.role) : null,
  };
}

function buildCaseAttention(
  run: AgentTeamRun,
  acceptanceCase: AgentTeamAcceptanceCase,
  issueCount: number,
): AgentTeamAttention {
  const target =
    getPanelById(run, acceptanceCase.bouncedToPanelId ?? null) ??
    getPanelByRole(run, "code");
  return {
    kind: "case",
    tone: "warning",
    title: "Case 未通过",
    severity: null,
    summary: acceptanceCase.resultSummary?.trim() || acceptanceCase.text.trim(),
    meta: `${acceptanceCase.sourceCaseId ?? acceptanceCase.caseId}${formatPanelMeta(target, Boolean(acceptanceCase.bouncedToPanelId))}`,
    issueCount,
    caseId: acceptanceCase.caseId,
    panelId: target?.panelId ?? null,
    panelLabel: target ? formatPanelLabel(target.role) : null,
  };
}

function getBouncedPanelId(
  run: AgentTeamRun,
  caseIds: string[],
): string | null {
  const selected = new Set(caseIds);
  return (
    run.acceptance.find(
      (item) => selected.has(item.caseId) && item.bouncedToPanelId,
    )?.bouncedToPanelId ?? null
  );
}

function getActivePanel(run: AgentTeamRun) {
  return run.activeWorkerRole
    ? getPanelByRole(run, run.activeWorkerRole)
    : getPanelByRole(run, "code");
}

function getPanelById(run: AgentTeamRun, panelId: string | null) {
  return panelId
    ? (run.workers.find((worker) => worker.panelId === panelId) ?? null)
    : null;
}

function getPanelByRole(run: AgentTeamRun, role: AgentTeamWorkerRole) {
  return (
    run.workers.find((worker) => worker.role === role && worker.panelId) ?? null
  );
}

function compareReviewSeverity(
  left: AgentTeamRepairCycle,
  right: AgentTeamRepairCycle,
): number {
  return (
    severityRank(left.lastFailureSummary) -
    severityRank(right.lastFailureSummary)
  );
}

function severityRank(summary: string): number {
  const severity = getFindingSeverity(summary);
  return severity ? Number(severity.slice(1)) : 4;
}

function getFindingSeverity(summary: string): string | null {
  return (
    summary
      .trim()
      .match(/^(P[0-3])(?:\s*[:：]|\s+)/i)?.[1]
      ?.toUpperCase() ?? null
  );
}

function stripFindingSeverity(summary: string): string {
  return summary
    .trim()
    .replace(/^P[0-3](?:\s*[:：]|\s+)/i, "")
    .trim();
}

function formatCaseIds(caseIds: string[], fallback: string): string {
  if (caseIds.length === 0) {
    return fallback;
  }
  if (caseIds.length <= 2) {
    return caseIds.join(", ");
  }
  return `${caseIds.slice(0, 2).join(", ")} 等 ${caseIds.length} 个 Case`;
}

function formatPanelMeta(
  panel: AgentTeamRun["workers"][number] | null,
  bounced: boolean,
): string {
  if (!panel) {
    return "";
  }
  const label = formatPanelLabel(panel.role);
  return bounced ? ` · 已抛回 ${label} pane` : ` · 处理位置：${label} pane`;
}

function formatPanelLabel(role: AgentTeamWorkerRole): string {
  return role === "code" ? "Code" : ROLE_LABEL[role];
}
