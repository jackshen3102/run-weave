import type { AppServerThreadRef } from "@runweave/shared/app-server-events";
import type { AppServerEventCenter } from "./event-center.js";
import type {
  CodexThreadStatusReader,
  CodexThreadStatusType,
} from "./codex-app-server-client.js";

const DEFAULT_START_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MS = 30_000;
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_CANDIDATE_THREADS = 100;

export interface CodexThreadStatusCompensatorOptions {
  eventCenter: AppServerEventCenter;
  statusReader: CodexThreadStatusReader;
  sourceInstanceId: string;
  startDelayMs?: number;
  intervalMs?: number;
}

export class CodexThreadStatusCompensator {
  private readonly startDelayMs: number;
  private readonly intervalMs: number;
  private startTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;

  constructor(private readonly options: CodexThreadStatusCompensatorOptions) {
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
      this.intervalTimer.unref?.();
    }, this.startDelayMs);
    this.startTimer.unref?.();
    logInfo("codex-thread-status-compensator.started", {
      message: "Codex thread status compensator scheduled",
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
    this.options.statusReader.shutdown();
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.reconcileOnce();
    } catch (error) {
      logWarn("codex-thread-status-compensator.failed", {
        message: "Codex thread status compensation round failed",
        error: serializeError(error),
      });
    } finally {
      this.running = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    for (const thread of this.collectCandidates()) {
      let status: CodexThreadStatusType | null = null;
      try {
        status = await this.options.statusReader.readThreadStatus(
          thread.threadId,
          { cwd: thread.cwd },
        );
      } catch (error) {
        logWarn("codex-thread-status-compensator.read-failed", {
          message: "Failed to read Codex thread status",
          threadId: thread.threadId,
          terminalSessionId: thread.terminalSessionId,
          error: serializeError(error),
        });
        continue;
      }
      if (!status) {
        continue;
      }
      const observedStatus = mapCodexThreadStatus(status, thread.status);
      if (!observedStatus || observedStatus === thread.status) {
        continue;
      }
      await this.recordStatusCompensation(thread, status, observedStatus);
    }
  }

  private collectCandidates(): AppServerThreadRef[] {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    return this.options.eventCenter
      .getStateStore()
      .listThreads({
        agent: "codex",
        limit: 10_000,
      })
      .filter((thread) => !thread.threadId.startsWith("unknown-thread:"))
      .filter((thread) => {
        const lastActivityAtMs = Date.parse(thread.lastActivityAt);
        return !Number.isFinite(lastActivityAtMs) || lastActivityAtMs >= cutoff;
      })
      .sort(
        (left, right) =>
          Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
      )
      .slice(0, MAX_CANDIDATE_THREADS);
  }

  private async recordStatusCompensation(
    thread: AppServerThreadRef,
    observedThreadStatus: CodexThreadStatusType,
    observedStatus: "idle" | "running",
  ): Promise<void> {
    const hookEvent =
      observedStatus === "running" ? "UserPromptSubmit" : "Stop";
    const result = await this.options.eventCenter.record({
      kind: "agent.hook",
      source: {
        app: "app-server",
        instanceId: this.options.sourceInstanceId,
        pid: process.pid,
      },
      scope: {
        projectId: thread.projectId,
        terminalSessionId: thread.terminalSessionId,
        terminalPanelId: thread.terminalPanelId,
        terminalTmuxPaneId: this.options.eventCenter
          .getStateStore()
          .getThreadTmuxPaneId(thread.threadId),
        runId: thread.runId,
        cwd: thread.cwd,
      },
      correlationId: thread.threadId,
      dedupeKey: [
        "codex-thread-status-compensation",
        thread.threadId,
        thread.lastEventId,
        observedThreadStatus,
        observedStatus,
      ].join(":"),
      payload: {
        source: "codex",
        rawHookEvent: hookEvent,
        normalizedEvent: hookEvent,
        stateHookEvent: hookEvent,
        panelId: thread.terminalPanelId,
        tmuxPaneId: this.options.eventCenter
          .getStateStore()
          .getThreadTmuxPaneId(thread.threadId),
        commandName: "codex",
        compensation: true,
        compensationReason: "codex_thread_status_mismatch",
        observedThreadStatus,
        previousAppServerStatus: thread.status,
        compensatedEventId: thread.lastEventId,
      },
    });
    if (!result.created) {
      return;
    }
    logInfo("codex-thread-status-compensator.compensated", {
      message: "Codex thread status mismatch compensated",
      threadId: thread.threadId,
      terminalSessionId: thread.terminalSessionId,
      observedThreadStatus,
      observedStatus,
      eventId: result.event.id,
    });
  }
}

function mapCodexThreadStatus(
  status: CodexThreadStatusType | null,
  currentStatus: AppServerThreadRef["status"],
): "idle" | "running" | null {
  if (status === "idle") {
    return "idle";
  }
  if (status === "active") {
    return "running";
  }
  if (status === "notLoaded" && currentStatus === "running") {
    return "idle";
  }
  return null;
}

export function parseOptionalPositiveInteger(
  value: string | undefined,
): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function logInfo(message: string, fields: Record<string, unknown>): void {
  console.log(formatLogEntry("info", message, fields));
}

function logWarn(message: string, fields: Record<string, unknown>): void {
  console.warn(formatLogEntry("warn", message, fields));
}

function formatLogEntry(
  level: "info" | "warn",
  message: string,
  fields: Record<string, unknown>,
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "runweave-app-server",
    message,
    ...fields,
  });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return {
    error: String(error),
  };
}
