import type {
  AttentionSlot,
  AttentionSnapshot,
  AttentionState,
} from "@runweave/shared/attention";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalCompletionEventService } from "../terminal/completion/event-service";
import type {
  TerminalPanelRecord,
  TerminalProjectContextRecord,
  TerminalSessionRecord,
} from "../terminal/manager/records";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { TerminalStateService } from "../terminal/state/terminal-state-service";
import type { TerminalQuestionsService } from "../terminal/questions/service";
import { resolveEffectiveTerminalState } from "../terminal/application/terminal-state-projection";

const PRIORITY: Record<AttentionState, number> = {
  needs_action: 600,
  blocked: 500,
  failed: 400,
  completed: 300,
  working: 200,
};

export type AttentionSlotCandidate = {
  slot: AttentionSlot;
  specificity: number;
};

type CompletionEnvelope = Extract<
  TerminalEventEnvelope,
  { kind: "completion" }
>;

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}

function sessionLabel(alias: string | null | undefined, contextName: string, activeCommand: string | null): string {
  const base = alias?.trim() || contextName;
  const command = activeCommand?.split(/[\\/]/u).filter(Boolean).at(-1);
  return command === "codex" ? `${base}(codex)` : base;
}

function panelLabel(panel: TerminalPanelRecord | undefined): string | null {
  return panel ? panel.alias?.trim() || panel.role?.trim() || panel.id.slice(0, 8) : null;
}

export function compareAttentionCandidates(
  left: AttentionSlotCandidate,
  right: AttentionSlotCandidate,
): number {
  return (
    PRIORITY[right.slot.state] - PRIORITY[left.slot.state] ||
    right.specificity - left.specificity ||
    right.slot.updatedAt.localeCompare(left.slot.updatedAt) ||
    left.slot.attentionId.localeCompare(right.slot.attentionId)
  );
}

function bestCandidate(candidates: AttentionSlotCandidate[]): AttentionSlot | undefined {
  return [...candidates].sort(compareAttentionCandidates)[0]?.slot;
}

export class AttentionService {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly completionEventService: TerminalCompletionEventService,
    private readonly terminalStateService: TerminalStateService,
    private readonly terminalQuestionsService?: Pick<TerminalQuestionsService, "findActivePendingQuestion"> | null,
    private readonly prWatches?: Pick<import("../pr-watch/service").PrWatchService, "get">,
  ) {}

  evaluateSession(terminalSessionId: string): {
    activeSlot: AttentionSlot | null;
    candidates: AttentionSlotCandidate[];
  } {
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      return { activeSlot: null, candidates: [] };
    }
    const contexts =
      this.terminalSessionManager.listAllProjectContexts() as TerminalProjectContextRecord[];
    const contextById = new Map(
      contexts.map((context) => [context.id, context]),
    );
    const context = contextById.get(session.projectId);
    const resolvedContext = context ?? {
      parentProjectId: session.projectId,
      name: session.projectId,
      branch: null,
    };
    const completions = this.completionEventService
      .listAfter(null)
      .filter((event): event is CompletionEnvelope => event.kind === "completion");
    const candidates = this.collectSessionCandidates(
      session,
      resolvedContext,
      contextById.get(resolvedContext.parentProjectId)?.name ??
        resolvedContext.name,
      completions,
    );
    const sorted = [...candidates].sort(compareAttentionCandidates);
    return {
      activeSlot: sorted[0]?.slot ?? null,
      candidates: sorted,
    };
  }

  findBlockingSlot(
    terminalSessionId: string,
    panelId: string | null,
  ): AttentionSlot | null {
    const { candidates } = this.evaluateSession(terminalSessionId);
    const blocking = candidates.find(
      ({ slot }) =>
        (slot.state === "needs_action" || slot.state === "blocked") &&
        (panelId === null || slot.panelId === null || slot.panelId === panelId),
    );
    return blocking?.slot ?? null;
  }

  async snapshot(): Promise<AttentionSnapshot> {
    const contexts = this.terminalSessionManager.listAllProjectContexts() as TerminalProjectContextRecord[];
    const contextById = new Map(contexts.map((context) => [context.id, context]));
    const completions = this.completionEventService
      .listAfter(null)
      .filter((event): event is CompletionEnvelope => event.kind === "completion");
    const slots: AttentionSlot[] = [];

    for (const session of this.terminalSessionManager.listSessions()) {
      const context = contextById.get(session.projectId);
      if (!context) continue;
      const candidates = this.collectSessionCandidates(
        session,
        context,
        contextById.get(context.parentProjectId)?.name ?? context.name,
        completions,
      );
      const best = bestCandidate(candidates);
      if (best) slots.push(best);
    }

    slots.sort((left, right) =>
      PRIORITY[right.state] - PRIORITY[left.state] ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.attentionId.localeCompare(right.attentionId)
    );
    return { generatedAt: new Date().toISOString(), slots };
  }

  private collectSessionCandidates(
    session: TerminalSessionRecord,
    context: Pick<TerminalProjectContextRecord, "parentProjectId" | "name" | "branch">,
    projectName: string,
    completions: CompletionEnvelope[],
  ): AttentionSlotCandidate[] {
    const panels = this.terminalSessionManager.listPanels(session.id);
    const base = {
      projectId: session.projectId,
      parentProjectId: context.parentProjectId,
      projectName,
      contextName: context.name,
      branch: context.branch,
      terminalSessionId: session.id,
      sessionLabel: sessionLabel(session.alias, context.name, session.activeCommand),
    };
    const candidates: AttentionSlotCandidate[] = [];
    const add = (slot: AttentionSlot, specificity = 0) => candidates.push({ slot, specificity });
    const withPanel = (panel: TerminalPanelRecord | undefined) => ({
      ...base,
      panelId: panel?.id ?? null,
      panelLabel: panelLabel(panel),
    });

    const question = this.terminalQuestionsService?.findActivePendingQuestion(session.id);
    if (question) {
      const panel = this.terminalSessionManager.getPanel(question.panelId);
      add({
        ...withPanel(panel),
        attentionId: `terminal:${session.id}:question:${question.panelId}:${question.threadId}:${question.turnId}:${question.itemId}`,
        state: "needs_action",
        actionKind: "question",
        title: "Codex 等待你的回答",
        detail: "打开目标面板完成结构化问答",
        updatedAt: question.updatedAt,
        source: { kind: "terminal_session", evidence: "terminal_question" },
        targetSurface: "terminal",
        completionRevision: null,
      }, 400);
    }

    const watch = this.prWatches?.get(session.id);
    if (
      watch?.status === "error" ||
      (watch?.status === "paused" &&
        watch.pauseReason &&
        ["wake_limit_reached", "draft_unconfirmed", "read_failed_limit"].includes(watch.pauseReason))
    ) {
      const evidence = watch.status === "error" ? "delivery_unconfirmed" : watch.pauseReason!;
      const watchPanel = this.terminalSessionManager.getPanel(watch.panelId);
      add({
        ...base,
        panelId: watch.panelId,
        panelLabel: panelLabel(watchPanel),
        attentionId: `pr-watch:${watch.watchId}:${evidence}`,
        state: "needs_action",
        actionKind: "pr_attention",
        title: watch.status === "error" ? `PR #${watch.prNumber} 值守投递待核实` : `PR #${watch.prNumber} 值守已暂停`,
        detail: watch.lastSummary ?? evidence,
        updatedAt: watch.lastCheckedAt ?? session.lastActivityAt.toISOString(),
        source: { kind: "terminal_session", evidence },
        targetSurface: "terminal",
        completionRevision: null,
      }, 350);
    }

    for (const panel of panels) {
      if (panel.status !== "running") continue;
      const permission = panel.pendingPermissionRequest;
      if (permission && panel.claude?.instanceId === permission.processGeneration &&
        panel.claude.sessionId === permission.sessionId) {
        const updatedAt = new Date(permission.hookTimestamp).toISOString();
        add({
          ...withPanel(panel),
          attentionId: `terminal:${session.id}:claude-perm:${panel.id}:${permission.sessionId}:${permission.hookTimestamp}`,
          state: "needs_action",
          actionKind: "permission",
          title: "Claude 请求执行权限",
          detail: "请打开目标面板确认",
          updatedAt,
          source: { kind: "terminal_session", evidence: "claude_permission_request" },
          targetSurface: "terminal",
          completionRevision: null,
        }, 300);
      }

      const agyQuestion = panel.pendingAgyQuestion;
      if (agyQuestion && panel.agy?.instanceId === agyQuestion.processGeneration &&
        panel.agy.conversationId === agyQuestion.conversationId) {
        add({
          ...withPanel(panel),
          attentionId: `terminal:${session.id}:agy-question:${panel.id}:${agyQuestion.eventId}`,
          state: "needs_action",
          actionKind: "question",
          title: "AGY 等待你的回答",
          detail: "请打开目标面板完成回答",
          updatedAt: new Date(agyQuestion.observedAt).toISOString(),
          source: { kind: "terminal_session", evidence: "agy_ask_question" },
          targetSurface: "terminal",
          completionRevision: null,
        }, 400);
      }

      if (panel.pi?.event === "ui_prompt_start" || panel.pi?.outcome === "failed") {
        const waiting = panel.pi.event === "ui_prompt_start";
        add({
          ...withPanel(panel),
          attentionId: `terminal:${session.id}:pi:${panel.pi.instanceId}:${panel.pi.sequence}`,
          state: waiting ? "needs_action" : "failed",
          ...(waiting ? { actionKind: "agent_prompt" as const } : {}),
          title: waiting ? "Pi 需要你处理" : "Pi 本轮执行失败",
          detail: waiting ? "打开目标面板完成确认或输入" : "打开目标面板查看错误并重试",
          updatedAt: panel.lastActivityAt.toISOString(),
          source: { kind: "terminal_session", evidence: panel.pi.event },
          targetSurface: "terminal",
          completionRevision: null,
        }, waiting ? 300 : 0);
      }

      if (panel.oscProgramStatus?.state === "blocked") {
        const kind = panel.oscProgramStatus.kind;
        const actionKind = kind ?? "agent_prompt";
        const updatedAt = panel.oscProgramStatus.observedAt ?? panel.lastActivityAt.toISOString();
        const title = kind === "permission" ? "终端需要授权"
          : kind === "question" ? "终端需要回答"
            : kind === "auth" ? "终端需要认证" : "Agent 需要你处理";
        add({
          ...withPanel(panel),
          attentionId: `terminal:${session.id}:osc-blocked:${panel.id}:${kind ?? "generic"}:${updatedAt}`,
          state: "needs_action",
          actionKind,
          title,
          detail: "请打开目标面板继续处理",
          updatedAt,
          source: { kind: "terminal_session", evidence: `osc7501:blocked:${kind ?? "generic"}` },
          targetSurface: "terminal",
          completionRevision: null,
        }, 200);
      }
    }

    if (panels.length === 0 && session.status === "running" && session.oscProgramStatus?.state === "blocked") {
      const kind = session.oscProgramStatus.kind;
      const actionKind = kind ?? "agent_prompt";
      const updatedAt = session.oscProgramStatus.observedAt ?? session.lastActivityAt.toISOString();
      const title = kind === "permission" ? "终端需要授权"
        : kind === "question" ? "终端需要回答"
          : kind === "auth" ? "终端需要认证" : "Agent 需要你处理";
      add({
        ...withPanel(undefined),
        attentionId: `terminal:${session.id}:osc-blocked:default:${kind ?? "generic"}:${updatedAt}`,
        state: "needs_action",
        actionKind,
        title,
        detail: "请打开目标面板继续处理",
        updatedAt,
        source: { kind: "terminal_session", evidence: `osc7501:blocked:${kind ?? "generic"}` },
        targetSurface: "terminal",
        completionRevision: null,
      }, 200);
    }

    if (session.status === "exited" && (session.exitCode ?? 0) !== 0) {
      add({
        ...withPanel(undefined),
        attentionId: `terminal:${session.id}:exit:${session.lastActivityAt.toISOString()}:${session.exitCode}`,
        state: "failed",
        title: clip(session.preview ?? session.alias ?? context.name, 100),
        detail: `Terminal 退出，exitCode=${session.exitCode}`,
        updatedAt: session.lastActivityAt.toISOString(),
        source: { kind: "terminal_session", evidence: `exitCode=${session.exitCode}` },
        targetSurface: "terminal",
        completionRevision: null,
      });
    }

    if (session.completionRevision > session.acknowledgedCompletionRevision) {
      const event = [...completions].reverse().find((candidate) =>
        candidate.terminalSessionId === session.id &&
        candidate.payload.completionRevision === session.completionRevision
      );
      const needsAction = event?.payload.completionReason === "notify" &&
        event.payload.rawHookEvent?.toLowerCase() === "notification" &&
        ["trae", "traex", "traecli"].includes(event.payload.source);
      const panel = event?.payload.panelId
        ? this.terminalSessionManager.getPanel(event.payload.panelId)
        : undefined;
      add({
        ...withPanel(panel),
        attentionId: `terminal:${session.id}:completion:${session.completionRevision}`,
        state: needsAction ? "needs_action" : "completed",
        ...(needsAction ? { actionKind: "agent_prompt" as const } : {}),
        title: clip(event?.payload.summary ?? (needsAction ? "Agent 需要你处理" : session.preview ?? "Agent 已完成本轮工作"), 100),
        detail: needsAction
          ? "Agent 发出了等待通知，请打开目标面板处理"
          : `${session.terminalState?.agent ?? "Agent"} completion 尚未确认`,
        updatedAt: event?.createdAt ?? session.lastActivityAt.toISOString(),
        source: { kind: "terminal_session", evidence: needsAction ? "trae_notification" : `completionRevision=${session.completionRevision}` },
        targetSurface: "terminal",
        completionRevision: session.completionRevision,
      }, needsAction ? 100 : 0);
    }

    let hasWorkingPanel = false;
    for (const panel of panels) {
      const working = panel.status === "running" && (
        panel.oscProgramStatus?.state === "starting" ||
        panel.oscProgramStatus?.state === "working" ||
        panel.terminalState?.state === "agent_starting" ||
        panel.terminalState?.state === "agent_running"
      );
      if (!working) continue;
      hasWorkingPanel = true;
      add({
        ...withPanel(panel),
        attentionId: `terminal:${session.id}:working:${panel.id}:${panel.lastActivityAt.toISOString()}`,
        state: "working",
        title: clip(panel.preview ?? session.preview ?? `${panel.terminalState?.agent ?? "Agent"} 正在执行`, 100),
        detail: panel.terminalState?.state === "agent_starting" ? "Agent 启动中" : "Agent 执行中",
        updatedAt: panel.lastActivityAt.toISOString(),
        source: {
          kind: "terminal_session",
          evidence: panel.oscProgramStatus?.state === "working"
            ? "osc7501:working"
            : `terminalState=${panel.terminalState?.state ?? "agent_running"}`,
        },
        targetSurface: "terminal",
        completionRevision: null,
      });
    }

    if (!hasWorkingPanel) {
      const effectiveTerminalState = resolveEffectiveTerminalState(
        this.terminalSessionManager,
        this.terminalStateService,
        session,
      );
      if (session.status === "running" &&
        (effectiveTerminalState.state === "agent_starting" || effectiveTerminalState.state === "agent_running")) {
        add({
          ...withPanel(undefined),
          attentionId: `terminal:${session.id}:working:${session.lastActivityAt.toISOString()}`,
          state: "working",
          title: clip(session.preview ?? `${effectiveTerminalState.agent ?? "Agent"} 正在执行`, 100),
          detail: effectiveTerminalState.state === "agent_starting" ? "Agent 启动中" : "Agent 执行中",
          updatedAt: session.lastActivityAt.toISOString(),
          source: { kind: "terminal_session", evidence: `terminalState=${effectiveTerminalState.state}` },
          targetSurface: "terminal",
          completionRevision: null,
        });
      }
    }

    return candidates;
  }
}
