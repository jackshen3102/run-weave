import type {
  AppServerAgentKind,
  AppServerThreadDetail,
  AppServerThreadRef,
} from "@runweave/shared/app-server-events";
import type { CodexThreadStatusReader } from "./codex-app-server-client.js";
import type { AppServerEventCenter } from "./event-center.js";
import type { TraeThreadLifecycleReader } from "./trae-thread-lifecycle-reader.js";

const DEFAULT_START_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MS = 30_000;
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_CANDIDATE_THREADS = 100;
const RECONCILED_AGENTS = new Set<AppServerAgentKind>([
  "codex",
  "trae",
  "traecli",
  "traex",
]);

interface ObservedThreadState {
  status: "idle" | "running";
  lifecycleType: string;
  lifecycleCursor: string;
  detailStatus: AppServerThreadDetail["status"] | null;
  preview: string | null;
  turnId: string | null;
}

export interface AgentThreadStatusReconcilerOptions {
  eventCenter: AppServerEventCenter;
  codexStatusReader: CodexThreadStatusReader;
  traeLifecycleReader: TraeThreadLifecycleReader;
  sourceInstanceId: string;
  startDelayMs?: number;
  intervalMs?: number;
}

export class AgentThreadStatusReconciler {
  private readonly startDelayMs: number;
  private readonly intervalMs: number;
  private startTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;

  constructor(private readonly options: AgentThreadStatusReconcilerOptions) {
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
    logInfo("agent-thread-status-reconciler.started", {
      message: "Agent thread status reconciler scheduled",
      startDelayMs: this.startDelayMs,
      intervalMs: this.intervalMs,
      providers: [...RECONCILED_AGENTS],
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
    this.options.codexStatusReader.shutdown();
    this.options.traeLifecycleReader.shutdown();
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.reconcileOnce();
    } catch (error) {
      logWarn("agent-thread-status-reconciler.failed", {
        message: "Agent thread status reconciliation round failed",
        error: serializeError(error),
      });
    } finally {
      this.running = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    for (const thread of this.collectCandidates()) {
      let observed: ObservedThreadState | null = null;
      try {
        observed = await this.readObservedState(thread);
      } catch (error) {
        logWarn("agent-thread-status-reconciler.read-failed", {
          message: "Failed to read agent thread status",
          provider: thread.agent,
          threadId: thread.threadId,
          terminalSessionId: thread.terminalSessionId,
          error: serializeError(error),
        });
        continue;
      }
      if (!observed || this.isAlreadyProjected(thread, observed)) {
        continue;
      }
      await this.recordObservation(thread, observed);
    }
  }

  private collectCandidates(): AppServerThreadRef[] {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    return this.options.eventCenter
      .getStateStore()
      .listThreads({ limit: 10_000 })
      .filter((thread) => RECONCILED_AGENTS.has(thread.agent))
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

  private async readObservedState(
    thread: AppServerThreadRef,
  ): Promise<ObservedThreadState | null> {
    if (thread.agent === "codex") {
      const status = await this.options.codexStatusReader.readThreadStatus(
        thread.threadId,
        { cwd: thread.cwd },
      );
      if (!status || status === "systemError") {
        return null;
      }
      const observedStatus =
        status === "active"
          ? "running"
          : status === "idle" ||
              (status === "notLoaded" && thread.status === "running")
            ? "idle"
            : null;
      return observedStatus
        ? {
            status: observedStatus,
            lifecycleType: `thread/read:${status}`,
            lifecycleCursor: `thread/read:${status}`,
            detailStatus: null,
            preview: null,
            turnId: null,
          }
        : null;
    }

    const detail = await this.options.traeLifecycleReader.readThread(
      thread.threadId,
      thread.agent,
    );
    const lifecycle = detail?.lifecycle.at(-1);
    if (!detail || !lifecycle) {
      return null;
    }
    const observedStatus =
      lifecycle.type === "task_started"
        ? "running"
        : lifecycle.type === "task_complete" ||
            lifecycle.type === "turn_aborted"
          ? "idle"
          : null;
    if (!observedStatus) {
      return null;
    }
    return {
      status: observedStatus,
      lifecycleType: lifecycle.type,
      lifecycleCursor: lifecycle.cursor,
      detailStatus: detail.status,
      preview: detail.preview,
      turnId: lifecycle.turnId,
    };
  }

  private isAlreadyProjected(
    thread: AppServerThreadRef,
    observed: ObservedThreadState,
  ): boolean {
    return (
      thread.lifecycleStatus === "available" &&
      thread.lastLifecycleCursor === observed.lifecycleCursor &&
      thread.lastLifecycleType === observed.lifecycleType &&
      thread.status === observed.status
    );
  }

  private async recordObservation(
    thread: AppServerThreadRef,
    observed: ObservedThreadState,
  ): Promise<void> {
    const compensation = observed.status !== thread.status;
    const result = await this.options.eventCenter.record({
      kind: "agent.lifecycle.observed",
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
        "agent-thread-lifecycle",
        thread.agent,
        thread.threadId,
        thread.lastEventId,
        observed.lifecycleType,
        observed.lifecycleCursor,
      ].join(":"),
      payload: {
        source: thread.agent,
        threadId: thread.threadId,
        observedStatus: observed.status,
        lifecycleStatus: "available",
        observedLifecycle: observed.lifecycleType,
        lifecycleCursor: observed.lifecycleCursor,
        detailStatus: observed.detailStatus,
        preview: observed.preview,
        turnId: observed.turnId,
        compensation,
        compensationReason: compensation
          ? `${thread.agent}_thread_status_mismatch`
          : null,
        previousAppServerStatus: thread.status,
        lastProjectedEventId: thread.lastEventId,
      },
    });
    if (!result.created) {
      return;
    }
    logInfo("agent-thread-status-reconciler.observed", {
      message: "Agent thread lifecycle observed",
      provider: thread.agent,
      threadId: thread.threadId,
      terminalSessionId: thread.terminalSessionId,
      observedLifecycle: observed.lifecycleType,
      observedStatus: observed.status,
      compensation,
      eventId: result.event.id,
    });
  }
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
  return { error: String(error) };
}
