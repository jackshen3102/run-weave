import { createHash } from "node:crypto";
import type {
  AttentionSlot,
  AttentionSnapshot,
  AttentionState,
} from "@runweave/shared/attention";
import type { AgentTeamRun } from "@runweave/shared/agent-team";
import type { TerminalSessionManager } from "../terminal/manager";
import type { TerminalCompletionEventService } from "../terminal/completion-event-service";
import type { AgentTeamService } from "../agent-team/service";
import type { TerminalProjectContextRecord } from "../terminal/manager-records";
import type { TerminalStateService } from "../terminal/terminal-state-service";
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

function stableHash(values: Array<string | number | null>): string {
  return createHash("sha256").update(values.join("\n")).digest("hex").slice(0, 16);
}

function selectRun(runs: AgentTeamRun[]): AgentTeamRun | null {
  return [...runs].sort((left, right) => {
    const leftActive = left.status !== "done" && left.status !== "failed";
    const rightActive = right.status !== "done" && right.status !== "failed";
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  })[0] ?? null;
}

function skippedAcceptance(run: AgentTeamRun): string[] {
  return run.acceptance
    .filter((item) => item.lastRunStatus === "skipped" || item.skip != null)
    .map((item) => item.caseId)
    .sort();
}

function projectRunSlot(
  run: AgentTeamRun,
  base: Omit<AttentionSlot, "attentionId" | "state" | "title" | "detail" | "updatedAt" | "source" | "targetSurface" | "completionRevision">,
): AttentionSlot | null {
  const pending = run.pendingFindingDecision;
  const skipped = skippedAcceptance(run);
  const skippedCase = run.acceptance.find(
    (item) => item.lastRunStatus === "skipped" || item.skip != null,
  );
  let state: AttentionState | null = null;
  let attentionId = "";
  let detail = "";
  if (pending) {
    state = "needs_action";
    attentionId = `agent-team:${run.runId}:finding:${pending.id}`;
    detail = pending.reason;
  } else if (run.frameworkRepair?.result === "blocked") {
    state = "blocked";
    attentionId = `agent-team:${run.runId}:framework-repair:${run.frameworkRepair.repairId}`;
    detail = run.frameworkRepair.reason;
  } else if (run.status === "need_human" && skipped.length > 0) {
    state = "blocked";
    attentionId = `agent-team:${run.runId}:acceptance:${stableHash([
      ...skipped,
      run.loop.round,
    ])}`;
    detail = `验收阻塞：${skipped.join("、")}`;
  } else if (run.status === "need_human") {
    state = "needs_action";
    attentionId = `agent-team:${run.runId}:human:${stableHash([
      run.loop.round,
      run.loop.lastReason,
    ])}`;
    detail = run.loop.lastReason ?? "需要人工介入";
  } else if (run.status === "failed") {
    state = "failed";
    attentionId = `agent-team:${run.runId}:failed`;
    detail = run.loop.lastReason ?? "Agent Team 执行失败";
  } else if (run.status === "running") {
    state = "working";
    attentionId = `agent-team:${run.runId}:working`;
    detail = run.task;
  }
  if (!state) return null;
  const reliablePanelId =
    run.activeWorkerDispatch?.panelId ?? run.mainPanelId ?? null;
  return {
    ...base,
    attentionId,
    panelId: reliablePanelId,
    panelLabel: run.activeWorkerRole ?? null,
    runId: run.runId,
    state,
    title: clip(
      pending?.finding.title ||
        (skippedCase ? `${skippedCase.caseId} · ${skippedCase.text}` : run.task) ||
        `Agent Team ${run.runId}`,
      100,
    ),
    detail: clip(detail, 180),
    updatedAt: run.updatedAt,
    source: { kind: "agent_team_run", evidence: `status=${run.status}` },
    targetSurface: "agent-team",
    completionRevision: null,
  };
}

export class AttentionService {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly completionEventService: TerminalCompletionEventService,
    private readonly agentTeamService: AgentTeamService,
    private readonly terminalStateService: TerminalStateService,
  ) {}

  async snapshot(): Promise<AttentionSnapshot> {
    // The manager returns context records at runtime; its legacy signature is
    // intentionally broader for existing consumers.
    const contexts = this.terminalSessionManager.listAllProjectContexts() as TerminalProjectContextRecord[];
    const contextById = new Map(contexts.map((context) => [context.id, context]));
    const runsByProject = new Map(
      await Promise.all(
        contexts.map(async (context) => [
          context.id,
          await this.agentTeamService.listRuns(context.id),
        ] as const),
      ),
    );
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
        runId: null,
      };
      const run = selectRun(
        (runsByProject.get(session.projectId) ?? []).filter(
          (candidate) => candidate.terminalSessionId === session.id,
        ),
      );
      const runSlot = run ? projectRunSlot(run, base) : null;
      if (runSlot) {
        slots.push(runSlot);
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
        slots.push({
          ...base,
          attentionId: `terminal:${session.id}:completion:${session.completionRevision}`,
          panelId: event?.payload.panelId ?? null,
          state: "completed",
          title: clip(event?.payload.summary ?? session.preview ?? "Agent 已完成本轮工作", 100),
          detail: `${session.terminalState?.agent ?? "Agent"} completion 尚未确认`,
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
