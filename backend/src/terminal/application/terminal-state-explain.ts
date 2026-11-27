import type { AttentionSlot } from "@runweave/shared/attention";
import type {
  TerminalAttentionSuppressedCandidateExplain,
  TerminalPanelAgentLeaseExplain,
  TerminalPanelExplain,
  TerminalPanelProgramStatusExplain,
  TerminalStateExplain,
  TerminalStateWinningSource,
} from "@runweave/shared/terminal/events";
import type { TerminalProgramStatus } from "@runweave/shared/terminal/program-status";
import type {
  AttentionService,
  AttentionSlotCandidate,
} from "../../attention/attention-service";
import { getExecutableCommandName } from "../completion/source-gate";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import type { TerminalQuestionsService } from "../questions/service";
import {
  getTerminalSessionAgent,
  type TerminalStateService,
} from "../state/terminal-state-service";

function sanitizeActiveCommand(command: string | null): string | null {
  if (!command) {
    return null;
  }
  return getExecutableCommandName(command) ?? command.trim().split(/\s+/u)[0] ?? null;
}

function mapProgramStatus(
  status: TerminalProgramStatus | undefined,
): TerminalPanelProgramStatusExplain | null {
  if (!status) {
    return null;
  }
  return {
    state: status.state,
    waitKind: status.kind ?? null,
    source: status.source,
    observedAt: status.observedAt ?? null,
  };
}

function mapAgentLease(
  manager: TerminalSessionManager,
  terminalSessionId: string,
  panelId: string | null,
): TerminalPanelAgentLeaseExplain | null {
  const lease = manager.getRecentAgentActivity(terminalSessionId, panelId);
  if (!lease) {
    return null;
  }
  return {
    phase: lease.phase,
    provider: lease.source,
    operationId: lease.operationId,
    observedAt: new Date(lease.observedAt).toISOString(),
    clearedAt:
      lease.clearedAt !== null ? new Date(lease.clearedAt).toISOString() : null,
  };
}

function sanitizeAttentionSlotForExplain(slot: AttentionSlot): AttentionSlot {
  if (slot.actionKind === "pr_attention") {
    return {
      ...slot,
      detail: slot.source.evidence,
    };
  }
  if (slot.state === "working") {
    return {
      ...slot,
      title: "Agent 正在执行",
    };
  }
  if (slot.state === "completed") {
    return {
      ...slot,
      title: "Agent 已完成本轮工作",
    };
  }
  if (slot.state === "failed" && slot.source.evidence.startsWith("exitCode=")) {
    return {
      ...slot,
      title: "Terminal 非零退出",
    };
  }
  return slot;
}

function buildSuppressedReason(
  winner: AttentionSlotCandidate,
  candidate: AttentionSlotCandidate,
): string {
  if (winner.slot.state !== candidate.slot.state) {
    return `suppressed_by_priority:${winner.slot.state}`;
  }
  if (winner.specificity !== candidate.specificity) {
    return `suppressed_by_specificity:${winner.slot.source.evidence}`;
  }
  return "suppressed_by_recency";
}

function resolveWinningSource(
  manager: TerminalSessionManager,
  stateService: TerminalStateService | undefined,
  session: TerminalSessionRecord,
): TerminalStateWinningSource {
  if (session.status === "exited") {
    return "session_exited";
  }
  const runningPanels = manager
    .listPanels(session.id)
    .filter((panel) => panel.status === "running");
  if (runningPanels.length > 0) {
    return "panel_aggregation";
  }
  if (!stateService) {
    return "persisted_fallback";
  }
  const agent = getTerminalSessionAgent(session);
  if (!agent) {
    return "state_service";
  }
  const stored = stateService.peekStored(session.id);
  if (stored?.agent === agent && stored.state !== "shell_idle") {
    return "state_service";
  }
  if (
    session.terminalState?.agent === agent &&
    session.terminalState.state !== "shell_idle"
  ) {
    return "persisted_fallback";
  }
  return "state_service";
}

function buildPanelExplain(
  manager: TerminalSessionManager,
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord,
  codexQuestion: { panelId: string; updatedAt: string } | null,
): TerminalPanelExplain {
  const permission = panel.pendingPermissionRequest;
  const claudePermissionValid = Boolean(
    panel.status === "running" &&
      permission &&
      panel.claude?.instanceId === permission.processGeneration &&
      panel.claude.sessionId === permission.sessionId,
  );
  const agyQuestion = panel.pendingAgyQuestion;
  const agyQuestionValid = Boolean(
    panel.status === "running" &&
      agyQuestion &&
      panel.agy?.instanceId === agyQuestion.processGeneration &&
      panel.agy.conversationId === agyQuestion.conversationId,
  );
  const hasCodexQuestion =
    panel.status === "running" && codexQuestion?.panelId === panel.id;

  return {
    panelId: panel.id,
    alias: panel.alias,
    role: panel.role,
    status: panel.status,
    activeCommand: sanitizeActiveCommand(panel.activeCommand),
    terminalState: panel.terminalState ?? null,
    agentLease: mapAgentLease(manager, session.id, panel.id),
    oscProgramStatus: mapProgramStatus(panel.oscProgramStatus),
    pendingPermissionRequest: {
      pending: claudePermissionValid,
      observedAt:
        claudePermissionValid && permission
          ? new Date(permission.hookTimestamp).toISOString()
          : null,
    },
    pendingQuestion: hasCodexQuestion
      ? {
          pending: true,
          provider: "codex",
          observedAt: codexQuestion.updatedAt,
        }
      : agyQuestionValid && agyQuestion
        ? {
            pending: true,
            provider: "agy",
            observedAt: new Date(agyQuestion.observedAt).toISOString(),
          }
        : {
            pending: false,
            provider: null,
            observedAt: null,
          },
    piWaitState: panel.pi
      ? {
          waiting: panel.pi.event === "ui_prompt_start",
          failed: panel.pi.outcome === "failed",
          event: panel.pi.event,
        }
      : null,
  };
}

export function buildTerminalStateExplain(params: {
  terminalSessionManager: TerminalSessionManager;
  terminalStateService?: TerminalStateService;
  attentionService?: AttentionService;
  terminalQuestionsService?: Pick<
    TerminalQuestionsService,
    "findActivePendingQuestion"
  > | null;
  session: TerminalSessionRecord;
}): TerminalStateExplain {
  const {
    terminalSessionManager,
    terminalStateService,
    attentionService,
    terminalQuestionsService,
    session,
  } = params;
  const winningSource = resolveWinningSource(
    terminalSessionManager,
    terminalStateService,
    session,
  );
  const codexQuestion =
    terminalQuestionsService?.findActivePendingQuestion(session.id) ?? null;
  const listedPanels = terminalSessionManager.listPanels(session.id);
  const panels: TerminalPanelExplain[] =
    listedPanels.length > 0
      ? listedPanels.map((panel) =>
          buildPanelExplain(
            terminalSessionManager,
            session,
            panel,
            codexQuestion,
          ),
        )
      : [
          {
            panelId: "default",
            alias: "main",
            role: "main",
            status: session.status,
            activeCommand: sanitizeActiveCommand(session.activeCommand),
            terminalState: session.terminalState ?? null,
            agentLease: mapAgentLease(terminalSessionManager, session.id, null),
            oscProgramStatus: mapProgramStatus(session.oscProgramStatus),
            pendingPermissionRequest: { pending: false, observedAt: null },
            pendingQuestion: {
              pending: false,
              provider: null,
              observedAt: null,
            },
            piWaitState: session.pi
              ? {
                  waiting: session.pi.event === "ui_prompt_start",
                  failed: session.pi.outcome === "failed",
                  event: session.pi.event,
                }
              : null,
          },
        ];

  const evaluation = attentionService?.evaluateSession(session.id) ?? {
    activeSlot: null,
    candidates: [],
  };
  const winner = evaluation.candidates[0];
  const suppressedCandidates: TerminalAttentionSuppressedCandidateExplain[] =
    winner
      ? evaluation.candidates.slice(1).map((candidate) => ({
          state: candidate.slot.state,
          ...(candidate.slot.actionKind
            ? { actionKind: candidate.slot.actionKind }
            : {}),
          panelId: candidate.slot.panelId,
          evidence: candidate.slot.source.evidence,
          reason: buildSuppressedReason(winner, candidate),
        }))
      : [];

  return {
    sessionStatus: session.status,
    winningSource,
    panels,
    attention: {
      activeSlot: evaluation.activeSlot
        ? sanitizeAttentionSlotForExplain(evaluation.activeSlot)
        : null,
      suppressedCandidates,
    },
  };
}
