import type {
  AppServerEventEnvelope,
  TerminalState,
} from "@runweave/shared";
import { logger } from "../logging";
import type { TerminalSessionManager, TerminalSessionRecord } from "../terminal/manager";
import {
  isCodexActiveCommand,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import type { AppServerClient } from "./client";
import type { AppServerEventCursorStore } from "./event-cursor-store";
import {
  isAppServerStopCompletion,
  readAppServerAgent,
  readAppServerHookEvent,
} from "./handlers/agent-event-payload";

const CODEX_INTERRUPT_RECONCILER_CONSUMER_ID =
  "codex-interrupt-state-reconciler";
const CODEX_INTERRUPT_RECONCILER_KINDS = [
  "agent.hook",
  "agent.completion",
];
const DEFAULT_START_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MS = 30_000;
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000;
const EVENT_PAGE_LIMIT = 500;
const MAX_EVENT_PAGES_PER_ROUND = 10;
const MAX_CANDIDATE_SESSIONS = 100;

interface CodexInterruptStateReconcilerOptions {
  client: AppServerClient;
  cursorStore: AppServerEventCursorStore;
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
  startDelayMs?: number;
  intervalMs?: number;
}

type ReconciledState = "agent_running" | "agent_idle";

interface ReconciledEventState {
  eventId: string;
  state: ReconciledState;
}

const reconcilerLogger = logger.child({
  component: "codex-interrupt-state-reconciler",
});

export class CodexInterruptStateReconciler {
  private readonly startDelayMs: number;
  private readonly intervalMs: number;
  private startTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;

  constructor(private readonly options: CodexInterruptStateReconcilerOptions) {
    this.startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.startTimer || this.intervalTimer) {
      return;
    }
    this.stopped = false;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.stopped) {
        return;
      }
      void this.tick();
      this.intervalTimer = setInterval(() => {
        void this.tick();
      }, this.intervalMs);
    }, this.startDelayMs);
    reconcilerLogger.info("codex-interrupt-reconciler.started", {
      message: "Codex interrupt state reconciler scheduled",
      consumerId: CODEX_INTERRUPT_RECONCILER_CONSUMER_ID,
      startDelayMs: this.startDelayMs,
      intervalMs: this.intervalMs,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      reconcilerLogger.debug("codex-interrupt-reconciler.skipped", {
        message: "Previous Codex interrupt reconciliation round is still running",
        consumerId: CODEX_INTERRUPT_RECONCILER_CONSUMER_ID,
      });
      return;
    }

    this.running = true;
    try {
      await this.reconcileOnce();
    } catch (error) {
      reconcilerLogger.warn("codex-interrupt-reconciler.failed", {
        message: "Codex interrupt reconciliation round failed",
        consumerId: CODEX_INTERRUPT_RECONCILER_CONSUMER_ID,
        error,
      });
    } finally {
      this.running = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const candidates = this.collectCandidates();
    if (candidates.size === 0) {
      return;
    }

    const latestBySession = new Map<string, ReconciledEventState>();
    let cursor = await this.options.cursorStore.read(
      CODEX_INTERRUPT_RECONCILER_CONSUMER_ID,
    );
    let finalCursor: string | null = null;
    let reachedLatest = false;

    for (let page = 0; page < MAX_EVENT_PAGES_PER_ROUND; page += 1) {
      const response = await this.options.client.listEvents({
        after: cursor,
        kinds: CODEX_INTERRUPT_RECONCILER_KINDS,
        limit: EVENT_PAGE_LIMIT,
      });
      if (!response) {
        reconcilerLogger.warn("codex-interrupt-reconciler.events.unavailable", {
          message: "App-server events unavailable for Codex interrupt reconciliation",
          consumerId: CODEX_INTERRUPT_RECONCILER_CONSUMER_ID,
        });
        return;
      }
      if (response.events.length === 0) {
        reachedLatest = true;
        finalCursor = response.latestEventId ?? finalCursor;
        break;
      }

      for (const event of response.events) {
        const terminalSessionId = event.scope?.terminalSessionId;
        if (!terminalSessionId || !candidates.has(terminalSessionId)) {
          continue;
        }
        const state = deriveCodexState(event);
        if (!state) {
          continue;
        }
        const previous = latestBySession.get(terminalSessionId);
        if (!previous || isNewerEventId(event.id, previous.eventId)) {
          latestBySession.set(terminalSessionId, {
            eventId: event.id,
            state,
          });
        }
      }

      const lastEvent = response.events.at(-1);
      finalCursor = lastEvent?.id ?? finalCursor;
      cursor = finalCursor;
      reachedLatest =
        response.events.length < EVENT_PAGE_LIMIT ||
        (finalCursor !== null && finalCursor === response.latestEventId);
      if (reachedLatest) {
        break;
      }
    }

    await this.applyLatestStates(candidates, latestBySession);
    if (finalCursor) {
      await this.options.cursorStore.write(
        CODEX_INTERRUPT_RECONCILER_CONSUMER_ID,
        finalCursor,
      );
    }
    if (!reachedLatest) {
      reconcilerLogger.warn("codex-interrupt-reconciler.page-limit", {
        message: "Codex interrupt reconciliation stopped at page limit",
        consumerId: CODEX_INTERRUPT_RECONCILER_CONSUMER_ID,
        maxPages: MAX_EVENT_PAGES_PER_ROUND,
        finalCursor,
      });
    }
  }

  private collectCandidates(): Map<string, TerminalSessionRecord> {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const candidates = this.options.terminalSessionManager
      .listSessions()
      .filter((session) => {
        if (session.status !== "running") {
          return false;
        }
        if (!isCodexActiveCommand(session.activeCommand)) {
          return false;
        }
        if (session.lastActivityAt.getTime() < cutoff) {
          return false;
        }
        if (!isCodexRunningState(session.terminalState)) {
          return false;
        }
        const current = this.options.terminalStateService.getCurrent(
          session.id,
          session,
        );
        return isCodexRunningState(current);
      })
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
      .slice(0, MAX_CANDIDATE_SESSIONS);

    return new Map(candidates.map((session) => [session.id, session]));
  }

  private async applyLatestStates(
    candidates: Map<string, TerminalSessionRecord>,
    latestBySession: Map<string, ReconciledEventState>,
  ): Promise<void> {
    for (const [terminalSessionId, reconciled] of latestBySession) {
      if (reconciled.state !== "agent_idle") {
        continue;
      }
      const candidate = candidates.get(terminalSessionId);
      const session =
        this.options.terminalSessionManager.getSession(terminalSessionId) ??
        candidate;
      if (!session || !isStillCodexRunningCandidate(session)) {
        continue;
      }
      const current = this.options.terminalStateService.getCurrent(
        session.id,
        session,
      );
      if (!isCodexRunningState(current)) {
        continue;
      }
      this.options.terminalStateService.handleAgentHook(
        session.id,
        "codex",
        "Stop",
        {
          projectId: session.projectId,
          reason: "agent_hook",
        },
      );
      reconcilerLogger.info("codex-interrupt-reconciler.reconciled", {
        message: "Codex terminal state reconciled from App-server event",
        consumerId: CODEX_INTERRUPT_RECONCILER_CONSUMER_ID,
        terminalSessionId: session.id,
        eventId: reconciled.eventId,
        state: "agent_idle",
      });
    }
  }
}

function deriveCodexState(event: AppServerEventEnvelope): ReconciledState | null {
  if (readAppServerAgent(event.payload) !== "codex") {
    return null;
  }
  if (event.kind === "agent.hook") {
    const hookEvent = readAppServerHookEvent(event.payload);
    if (hookEvent === "UserPromptSubmit") {
      return "agent_running";
    }
    if (hookEvent === "Stop") {
      return "agent_idle";
    }
    return null;
  }
  if (
    event.kind === "agent.completion" &&
    isAppServerStopCompletion(event.payload)
  ) {
    return "agent_idle";
  }
  return null;
}

function isStillCodexRunningCandidate(session: TerminalSessionRecord): boolean {
  return (
    session.status === "running" &&
    isCodexActiveCommand(session.activeCommand) &&
    Date.now() - session.lastActivityAt.getTime() <= ACTIVE_WINDOW_MS &&
    isCodexRunningState(session.terminalState)
  );
}

function isCodexRunningState(
  state: TerminalState | null | undefined,
): boolean {
  return state?.state === "agent_running" && state.agent === "codex";
}

function isNewerEventId(next: string, previous: string): boolean {
  if (/^\d+$/.test(next) && /^\d+$/.test(previous)) {
    return BigInt(next) > BigInt(previous);
  }
  return next > previous;
}
