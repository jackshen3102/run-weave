import type {
  AttentionSlot,
  AttentionSnapshot,
  AttentionState,
} from "@runweave/shared/attention";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalCompletionEventService } from "../terminal/completion/event-service";
import type { TerminalProjectContextRecord } from "../terminal/manager/records";
import type { TerminalStateService } from "../terminal/state/terminal-state-service";
import { resolveEffectiveTerminalState } from "../terminal/application/terminal-state-projection";

const PRIORITY: Record<AttentionState, number> = {
  needs_action: 600,
  blocked: 500,
  failed: 400,
  completed: 300,
  working: 200,
};

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

export class AttentionService {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly completionEventService: TerminalCompletionEventService,
    private readonly terminalStateService: TerminalStateService,
  ) {}

  async snapshot(): Promise<AttentionSnapshot> {
    // The manager returns context records at runtime; its legacy signature is
    // intentionally broader for existing consumers.
    const contexts = this.terminalSessionManager.listAllProjectContexts() as TerminalProjectContextRecord[];
    const contextById = new Map(contexts.map((context) => [context.id, context]));
    const completions = this.completionEventService
      .listAfter(null)
      .filter((event) => event.kind === "completion");
    const slots: AttentionSlot[] = [];

    for (const session of this.terminalSessionManager.listSessions()) {
      const context = contextById.get(session.projectId);
      if (!context) continue;
      const base = {
        projectId: session.projectId,
        parentProjectId: context.parentProjectId,
        projectName:
          contextById.get(context.parentProjectId)?.name ?? context.name,
        contextName: context.name,
        branch: context.branch,
        terminalSessionId: session.id,
        sessionLabel: sessionLabel(session.alias, context.name, session.activeCommand),
        panelId: null,
        panelLabel: null,
      };
      const piPanel = this.terminalSessionManager.listPanels(session.id).find((panel) =>
        panel.status === "running" && panel.terminalState?.agent === "pi" &&
        (panel.pi?.event === "ui_prompt_start" || panel.pi?.outcome === "failed"));
      if (piPanel?.pi) {
        const waiting = piPanel.pi.event === "ui_prompt_start";
        slots.push({ ...base, panelId: piPanel.id,
          attentionId: `terminal:${session.id}:pi:${piPanel.pi.instanceId}:${piPanel.pi.sequence}`,
          state: waiting ? "needs_action" : "failed", title: waiting ? "Pi 需要你处理" : "Pi 本轮执行失败",
          detail: waiting ? "打开终端完成确认或输入" : "打开终端查看错误并重试",
          updatedAt: piPanel.lastActivityAt.toISOString(), source: { kind: "terminal_session", evidence: piPanel.pi.event },
          targetSurface: "terminal", completionRevision: null });
        continue;
      }
      if (session.status === "exited" && (session.exitCode ?? 0) !== 0) {
        slots.push({
          ...base,
          attentionId: `terminal:${session.id}:exit:${session.lastActivityAt.toISOString()}:${session.exitCode}`,
          state: "failed",
          title: clip(session.preview ?? session.alias ?? context.name, 100),
          detail: `Terminal 退出，exitCode=${session.exitCode}`,
          updatedAt: session.lastActivityAt.toISOString(),
          source: { kind: "terminal_session", evidence: `exitCode=${session.exitCode}` },
          targetSurface: "terminal",
          completionRevision: null,
        });
        continue;
      }
      if (session.completionRevision > session.acknowledgedCompletionRevision) {
        const event = [...completions]
          .reverse()
          .find(
            (candidate) =>
              candidate.terminalSessionId === session.id &&
              candidate.payload.completionRevision === session.completionRevision,
          );
        const needsAction =
          event?.payload.completionReason === "notify" &&
          event.payload.rawHookEvent?.toLowerCase() === "notification" &&
          ["trae", "traex", "traecli"].includes(event.payload.source);
        slots.push({
          ...base,
          attentionId: `terminal:${session.id}:completion:${session.completionRevision}`,
          panelId: event?.payload.panelId ?? null,
          state: needsAction ? "needs_action" : "completed",
          title: clip(event?.payload.summary ?? (needsAction ? "Agent 需要你处理" : session.preview ?? "Agent 已完成本轮工作"), 100),
          detail: needsAction
            ? "Agent 发出了等待通知，请打开终端查看确认或输入请求"
            : `${session.terminalState?.agent ?? "Agent"} completion 尚未确认`,
          updatedAt: event?.createdAt ?? session.lastActivityAt.toISOString(),
          source: { kind: "terminal_session", evidence: `completionRevision=${session.completionRevision}` },
          targetSurface: "terminal",
          completionRevision: session.completionRevision,
        });
        continue;
      }
      const effectiveTerminalState = resolveEffectiveTerminalState(
        this.terminalSessionManager,
        this.terminalStateService,
        session,
      );
      if (
        session.status === "running" &&
        (effectiveTerminalState.state === "agent_starting" ||
          effectiveTerminalState.state === "agent_running")
      ) {
        slots.push({
          ...base,
          attentionId: `terminal:${session.id}:working:${session.lastActivityAt.toISOString()}`,
          state: "working",
          title: clip(
            session.preview ??
              `${effectiveTerminalState.agent ?? "Agent"} 正在执行`,
            100,
          ),
          detail:
            effectiveTerminalState.state === "agent_starting"
              ? "Agent 启动中"
              : "Agent 执行中",
          updatedAt: session.lastActivityAt.toISOString(),
          source: {
            kind: "terminal_session",
            evidence: `terminalState=${effectiveTerminalState.state}`,
          },
          targetSurface: "terminal",
          completionRevision: null,
        });
      }
    }
    slots.sort(
      (left, right) =>
        PRIORITY[right.state] - PRIORITY[left.state] ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.attentionId.localeCompare(right.attentionId),
    );
    return { generatedAt: new Date().toISOString(), slots };
  }
}
