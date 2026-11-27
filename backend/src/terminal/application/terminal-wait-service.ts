import type { AttentionSlot } from "@runweave/shared/attention";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { TerminalProgramStatusState } from "@runweave/shared/terminal/program-status";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type {
  TerminalSendAndWaitRequest,
  TerminalSendAndWaitResponse,
  TerminalWaitOutputRequest,
  TerminalWaitOutputResponse,
  TerminalWaitTargetState,
} from "@runweave/shared/terminal/wait";
import type { AttentionService } from "../../attention/attention-service";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import { isTmuxBackedSession } from "../runtime/launcher";
import type { PtyService } from "../runtime/pty-service";
import type { TerminalRuntimeRegistry } from "../runtime/registry";
import type { TerminalQuickInputService } from "../quick-input/service";
import type { TerminalEventService } from "../state/terminal-event-service";
import {
  aggregatePanelTerminalState,
  type TerminalStateService,
} from "../state/terminal-state-service";
import type { TmuxOutputWatcher } from "../tmux/output-watcher";
import type { TmuxService } from "../tmux/service";
import { normalizeCodexSlashCommand } from "./input-dispatcher";
import { resolvePanelTarget } from "./panel-targets";
import { submitTerminalInput } from "./submit-input";
import { resolveEffectiveTerminalState } from "./terminal-state-projection";
import {
  DEFAULT_WAIT_OUTPUT_LINES,
  DEFAULT_WAIT_OUTPUT_TIMEOUT_MS,
  executeWaitForOutput,
  waitForWakeOrDeadline,
} from "./terminal-wait-output";

export { DEFAULT_WAIT_OUTPUT_LINES, DEFAULT_WAIT_OUTPUT_TIMEOUT_MS };
export const MAX_CONCURRENT_TERMINAL_WAITS = 32;
export const DEFAULT_SEND_WAIT_TIMEOUT_MS = 120_000;
export const DEFAULT_ACTIVITY_GATE_MS = 5_000;
const EVENT_RECHECK_INTERVAL_MS = 200;

export class TerminalWaitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TerminalWaitError";
  }
}

interface TargetObservation {
  exited: boolean;
  terminalState: TerminalState;
  oscState: TerminalProgramStatusState | null;
  blockingSlot: AttentionSlot | null;
  activeSlot: AttentionSlot | null;
  isRunningActivity: boolean;
  isStarting: boolean;
  isBlocked: boolean;
}

function resolveTargetPanelState(
  manager: TerminalSessionManager,
  stateService: TerminalStateService | undefined,
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord | null,
): TerminalState {
  if (!panel) {
    return (
      resolveEffectiveTerminalState(manager, stateService, session) ?? {
        state: "shell_idle",
        agent: null,
      }
    );
  }
  if (panel.terminalState) {
    return panel.terminalState;
  }
  if (manager.listPanels(session.id).length <= 1 && stateService) {
    return stateService.getCurrent(session.id, session);
  }
  return aggregatePanelTerminalState([panel]);
}

function buildSendWaitResponse(params: {
  operationId: string;
  terminalSessionId: string;
  panelId: string | null;
  inputAccepted: boolean;
  startedAt: number;
  obs: TargetObservation;
  outcome: TerminalSendAndWaitResponse["outcome"];
  matchedState: TerminalWaitTargetState | null;
  code?: TerminalSendAndWaitResponse["code"];
  note?: string;
}): TerminalSendAndWaitResponse {
  const slot = params.obs.blockingSlot ?? params.obs.activeSlot;
  return {
    operationId: params.operationId,
    terminalSessionId: params.terminalSessionId,
    panelId: params.panelId,
    inputAccepted: params.inputAccepted,
    outcome: params.outcome,
    ...(params.code ? { code: params.code } : {}),
    matchedState: params.matchedState,
    terminalState: params.obs.terminalState,
    attentionState: slot?.state ?? null,
    ...(slot?.actionKind ? { attentionActionKind: slot.actionKind } : {}),
    elapsedMs: Math.max(0, Date.now() - params.startedAt),
    ...(params.note ? { note: params.note } : {}),
  };
}

export class TerminalWaitService {
  private activeWaits = 0;

  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly options: {
      attentionService?: AttentionService;
      ptyService?: PtyService;
      runtimeRegistry?: TerminalRuntimeRegistry;
      tmuxService?: TmuxService;
      tmuxOutputWatcher?: TmuxOutputWatcher;
      terminalEventService?: TerminalEventService;
      terminalStateService?: TerminalStateService;
      quickInputService?: TerminalQuickInputService;
    },
  ) {}

  getActiveWaitCount(): number {
    return this.activeWaits;
  }

  private acquireWaitSlot(): () => void {
    if (this.activeWaits >= MAX_CONCURRENT_TERMINAL_WAITS) {
      throw new TerminalWaitError(
        429,
        "TOO_MANY_WAIT_REQUESTS",
        `Too many concurrent terminal wait requests (limit: ${MAX_CONCURRENT_TERMINAL_WAITS})`,
      );
    }
    this.activeWaits += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeWaits = Math.max(0, this.activeWaits - 1);
      }
    };
  }

  private observeTarget(
    terminalSessionId: string,
    targetPanelId: string | null,
  ): TargetObservation {
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    const panel = targetPanelId
      ? (this.terminalSessionManager.getPanel(targetPanelId) ?? null)
      : null;
    if (
      !session ||
      session.status !== "running" ||
      (targetPanelId !== null && (!panel || panel.status !== "running"))
    ) {
      return {
        exited: true,
        terminalState: { state: "shell_idle", agent: null },
        oscState: null,
        blockingSlot: null,
        activeSlot: null,
        isRunningActivity: false,
        isStarting: false,
        isBlocked: false,
      };
    }

    const terminalState = resolveTargetPanelState(
      this.terminalSessionManager,
      this.options.terminalStateService,
      session,
      panel,
    );
    const oscState = panel
      ? (panel.oscProgramStatus?.state ?? null)
      : (session.oscProgramStatus?.state ?? null);
    const blockingSlot =
      this.options.attentionService?.findBlockingSlot(
        session.id,
        targetPanelId,
      ) ?? null;
    const activeSlot =
      this.options.attentionService?.evaluateSession(session.id).activeSlot ??
      null;

    return {
      exited: false,
      terminalState,
      oscState,
      blockingSlot,
      activeSlot,
      isRunningActivity:
        terminalState.state === "agent_running" || oscState === "working",
      isStarting:
        terminalState.state === "agent_starting" || oscState === "starting",
      isBlocked: blockingSlot !== null,
    };
  }

  private assertNotBlocked(
    terminalSessionId: string,
    targetPanelId: string | null,
    rejectIfBlocked: boolean,
  ): void {
    if (!rejectIfBlocked) {
      return;
    }
    const blockingSlot =
      this.options.attentionService?.findBlockingSlot(
        terminalSessionId,
        targetPanelId,
      ) ?? null;
    if (!blockingSlot) {
      return;
    }
    throw new TerminalWaitError(
      409,
      "AGENT_BLOCKED",
      `AGENT_BLOCKED: ${blockingSlot.title} (${blockingSlot.source.evidence})`,
      {
        terminalSessionId,
        panelId: blockingSlot.panelId ?? targetPanelId,
        attentionState: blockingSlot.state,
        actionKind: blockingSlot.actionKind ?? null,
        evidence: blockingSlot.source.evidence,
      },
    );
  }

  private validateSendSession(
    terminalSessionId: string,
    request: TerminalSendAndWaitRequest,
  ): TerminalSessionRecord {
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      throw new TerminalWaitError(
        404,
        "SESSION_NOT_FOUND",
        "Terminal session not found",
      );
    }
    if (session.status !== "running") {
      throw new TerminalWaitError(
        409,
        "SESSION_NOT_RUNNING",
        "Terminal session is not running",
      );
    }
    if (!this.options.runtimeRegistry || !this.options.ptyService) {
      throw new TerminalWaitError(
        503,
        "RUNTIME_UNAVAILABLE",
        "Terminal runtime service unavailable",
      );
    }
    if (isTmuxBackedSession(session) && !this.options.tmuxService) {
      throw new TerminalWaitError(
        503,
        "TMUX_UNAVAILABLE",
        "Terminal tmux service unavailable",
      );
    }
    if (
      request.mode === "codex_slash_command" &&
      !normalizeCodexSlashCommand(request.data)
    ) {
      throw new TerminalWaitError(
        400,
        "INVALID_REQUEST",
        "Invalid Codex slash command input",
      );
    }
    return session;
  }

  async sendAndWait(
    terminalSessionId: string,
    request: TerminalSendAndWaitRequest,
    context?: {
      signal?: AbortSignal;
      mobileReplySessionId?: string;
    },
  ): Promise<TerminalSendAndWaitResponse> {
    const session = this.validateSendSession(terminalSessionId, request);
    const releaseSlot = this.acquireWaitSlot();
    const wakeListeners = new Set<() => void>();
    const notifyWake = () => wakeListeners.forEach((listener) => listener());
    let unsubscribeEvent: (() => void) | undefined;
    let unsubscribePanel: (() => void) | undefined;

    try {
      const resolvedPanel =
        isTmuxBackedSession(session) && this.options.tmuxService
          ? await resolvePanelTarget(
              this.terminalSessionManager,
              session,
              {
                tmuxService: this.options.tmuxService,
                terminalEventService: this.options.terminalEventService,
              },
              {
                panelId: request.panelId,
                panelAlias: request.panelAlias,
                role: request.role,
              },
              "explicit-or-active",
            )
          : null;
      const targetPanelId = resolvedPanel?.panel.id ?? null;
      const rejectIfBlocked = request.wait.rejectIfBlocked !== false;
      const untilStates: ReadonlySet<TerminalWaitTargetState> = new Set(
        request.wait.until?.length ? request.wait.until : ["idle", "blocked"],
      );
      const timeoutMs = request.wait.timeoutMs ?? DEFAULT_SEND_WAIT_TIMEOUT_MS;
      const activityGateMs =
        request.wait.activityGateMs ?? DEFAULT_ACTIVITY_GATE_MS;

      this.assertNotBlocked(session.id, targetPanelId, rejectIfBlocked);

      const preObservation = this.observeTarget(session.id, targetPanelId);
      const initialBlockedId = preObservation.blockingSlot?.attentionId ?? null;
      let initialBlockCleared = initialBlockedId === null;
      const hasFreshBlock = (obs: TargetObservation): boolean => {
        if (!obs.blockingSlot) {
          initialBlockCleared = true;
          return false;
        }
        return (
          initialBlockCleared ||
          obs.blockingSlot.attentionId !== initialBlockedId
        );
      };

      let sawActivity = preObservation.isRunningActivity;
      const isSinglePanelSession =
        this.terminalSessionManager.listPanels(session.id).length <= 1;

      unsubscribeEvent = this.options.terminalEventService?.subscribe(
        (event: TerminalEventEnvelope) => {
          if (event.terminalSessionId !== session.id) return;
          if (
            event.kind === "terminal_state_changed" &&
            (targetPanelId === null || isSinglePanelSession) &&
            event.payload.next.state === "agent_running"
          ) {
            sawActivity = true;
          }
          if (
            event.kind === "terminal_panel_updated" &&
            (targetPanelId === null ||
              event.payload.panel.panelId === targetPanelId)
          ) {
            const pState = event.payload.panel.terminalState?.state;
            const oState = event.payload.panel.programStatus?.state;
            if (pState === "agent_running" || oState === "working") {
              sawActivity = true;
            }
          }
          const current = this.observeTarget(session.id, targetPanelId);
          if (current.isRunningActivity || hasFreshBlock(current)) {
            sawActivity = true;
          }
          notifyWake();
        },
      );
      if (targetPanelId) {
        unsubscribePanel = this.terminalSessionManager.subscribePanelMutations(
          targetPanelId,
          () => {
            const current = this.observeTarget(session.id, targetPanelId);
            if (current.isRunningActivity || hasFreshBlock(current)) {
              sawActivity = true;
            }
            notifyWake();
          },
        );
      }

      const mode = request.mode ?? "line";
      const submit =
        request.submit ?? (mode === "prompt_replace" ? true : undefined);
      const startedAt = Date.now();
      const inputResponse = await submitTerminalInput(
        this.terminalSessionManager,
        {
          ...this.options,
          mobileReplySessionId: context?.mobileReplySessionId,
        },
        session,
        {
          operationId: request.operationId,
          data: request.data,
          panelId: targetPanelId ?? request.panelId,
          panelAlias: targetPanelId ? undefined : request.panelAlias,
          role: targetPanelId ? undefined : request.role,
          mode,
          submit,
        },
        () => this.assertNotBlocked(session.id, targetPanelId, rejectIfBlocked),
      );

      const overallDeadline = startedAt + timeoutMs;
      const registerWake = (wake: () => void) => {
        wakeListeners.add(wake);
        return () => wakeListeners.delete(wake);
      };
      const base = {
        operationId: inputResponse.operationId,
        terminalSessionId: session.id,
        panelId: targetPanelId,
        inputAccepted: inputResponse.inputAccepted,
        startedAt,
      };

      if (!sawActivity) {
        const gateDeadline = Math.min(
          overallDeadline,
          Date.now() + activityGateMs,
        );
        while (!context?.signal?.aborted) {
          const obs = this.observeTarget(session.id, targetPanelId);
          if (obs.exited) {
            return buildSendWaitResponse({
              ...base,
              obs,
              outcome: "session_exited",
              matchedState: null,
              code: "SESSION_EXITED",
              note: "目标终端或面板在等待期间退出。",
            });
          }
          if (obs.isRunningActivity || hasFreshBlock(obs) || sawActivity) {
            sawActivity = true;
            break;
          }
          if (Date.now() >= gateDeadline) {
            return buildSendWaitResponse({
              ...base,
              obs,
              outcome: "stalled",
              matchedState: null,
              code: "AGENT_PROMPT_STALLED",
              note: "输入已提交但未在活动门禁窗口内观测到运行态变化，请先读取快照确认，不要盲目重发。",
            });
          }
          await waitForWakeOrDeadline({
            deadlineAt: gateDeadline,
            intervalMs: EVENT_RECHECK_INTERVAL_MS,
            signal: context?.signal,
            registerWake,
          });
        }
      }

      while (!context?.signal?.aborted) {
        const obs = this.observeTarget(session.id, targetPanelId);
        if (obs.exited) {
          return buildSendWaitResponse({
            ...base,
            obs,
            outcome: "session_exited",
            matchedState: null,
            code: "SESSION_EXITED",
            note: "目标终端或面板在等待期间退出。",
          });
        }
        if (untilStates.has("blocked") && hasFreshBlock(obs)) {
          return buildSendWaitResponse({
            ...base,
            obs,
            outcome: "settled",
            matchedState: "blocked",
          });
        }
        if (
          untilStates.has("idle") &&
          !obs.isBlocked &&
          !obs.isRunningActivity &&
          !obs.isStarting
        ) {
          return buildSendWaitResponse({
            ...base,
            obs,
            outcome: "settled",
            matchedState: "idle",
          });
        }
        if (Date.now() >= overallDeadline) {
          return buildSendWaitResponse({
            ...base,
            obs,
            outcome: "timeout",
            matchedState: null,
            code: "WAIT_TIMEOUT",
            note: "输入已提交，结果未知，切勿盲目重发。",
          });
        }
        await waitForWakeOrDeadline({
          deadlineAt: overallDeadline,
          intervalMs: EVENT_RECHECK_INTERVAL_MS,
          signal: context?.signal,
          registerWake,
        });
      }

      return buildSendWaitResponse({
        ...base,
        obs: this.observeTarget(session.id, targetPanelId),
        outcome: "timeout",
        matchedState: null,
        code: "WAIT_TIMEOUT",
        note: "客户端连接提前断开；输入已提交，结果未知，切勿盲目重发。",
      });
    } finally {
      unsubscribeEvent?.();
      unsubscribePanel?.();
      wakeListeners.clear();
      releaseSlot();
    }
  }

  async waitForOutput(
    terminalSessionId: string,
    request: TerminalWaitOutputRequest,
    context?: { signal?: AbortSignal },
  ): Promise<TerminalWaitOutputResponse> {
    if (!this.terminalSessionManager.getSession(terminalSessionId)) {
      throw new TerminalWaitError(
        404,
        "SESSION_NOT_FOUND",
        "Terminal session not found",
      );
    }

    const hasMatch =
      typeof request.match === "string" && request.match.length > 0;
    const hasRegex =
      typeof request.regex === "string" && request.regex.length > 0;
    if (hasMatch === hasRegex) {
      throw new TerminalWaitError(
        400,
        "INVALID_REQUEST",
        "Provide exactly one of match or regex",
      );
    }

    let compiledRegex: RegExp | null = null;
    if (hasRegex) {
      if (request.regex!.length > 512) {
        throw new TerminalWaitError(
          400,
          "INVALID_REGEX",
          "INVALID_REGEX: Regular expression exceeds 512 characters",
        );
      }
      try {
        compiledRegex = new RegExp(request.regex!);
      } catch (error) {
        throw new TerminalWaitError(
          400,
          "INVALID_REGEX",
          `INVALID_REGEX: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const releaseSlot = this.acquireWaitSlot();
    try {
      return await executeWaitForOutput({
        terminalSessionId,
        request,
        compiledRegex,
        terminalSessionManager: this.terminalSessionManager,
        tmuxService: this.options.tmuxService,
        terminalEventService: this.options.terminalEventService,
        signal: context?.signal,
      });
    } finally {
      releaseSlot();
    }
  }
}
