import { stat } from "node:fs/promises";
import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";
import type { TerminalSessionRecord } from "../terminal/manager";
import { AgentTeamCompletionService } from "./service-completion";
import { agentTeamLogger } from "./service-context";
import {
  ensureWorkerGateAcceptance,
  findActiveRecheckCases,
  findRecheckWatchdogCases,
  groupRecheckCasesByWorker,
  isGateWorkerOutbox,
  isReviewGateAcceptanceCase,
  resolveRecheckDispatches,
  synthesizeBlockingReviewResults,
} from "./service-acceptance-policy";
import {
  createActiveWorkerDispatch,
  findWorkerByRole,
  setActiveWorker,
} from "./service-workflow-policy";
import {
  rawBlockingReviewFindings,
  resolveRepairTargets,
  type AgentTeamRepairTarget,
} from "./repair-loop";

const RECHECK_WATCHDOG_INTERVAL_MS = 10_000;
const RECHECK_TIMEOUT_MS = 60 * 60 * 1000;
const RECHECK_WATCHDOG_MAX_CONTINUOUS_GAP_MS = RECHECK_WATCHDOG_INTERVAL_MS * 3;
const MAX_RECHECK_ATTEMPTS = 2;

type RecheckWatchdogClock = {
  lastObservedAtMs: number;
  activeElapsedMs: number;
};

export class AgentTeamRecheckService extends AgentTeamCompletionService {
  private readonly recheckWatchdogClocks = new Map<
    string,
    RecheckWatchdogClock
  >();

  protected startRecheckWatchdog(): void {
    if (this.recheckWatchdogTimer) {
      return;
    }
    this.recheckWatchdogTimer = setInterval(() => {
      void this.runRecheckWatchdog("watchdog").catch((error) => {
        agentTeamLogger.warn("agent-team.recheck_watchdog.failed", {
          message: "Could not scan pending rechecks",
          error,
        });
      });
    }, RECHECK_WATCHDOG_INTERVAL_MS);
    this.recheckWatchdogTimer.unref?.();
  }

  protected async runRecheckWatchdog(
    source: "startup" | "watchdog",
  ): Promise<void> {
    const projects = this.terminalSessionManager.listAllProjectContexts();
    for (const project of projects) {
      const runs = await this.runStore.listRuns(project.id);
      for (const run of runs) {
        if (run.phase !== "executing" || run.status !== "running") {
          continue;
        }
        const session = this.terminalSessionManager.getSession(
          run.terminalSessionId,
        );
        const activeWorker = run.activeWorkerRole
          ? findWorkerByRole(run.workers, run.activeWorkerRole)
          : null;
        if (!session || !activeWorker) {
          continue;
        }
        const reconciled = await this.reconcileCompletionSignal({
          projectId: run.projectId,
          terminalSessionId: run.terminalSessionId,
          panelId: activeWorker.panelId ?? null,
          tmuxPaneId: activeWorker.tmuxPaneId ?? null,
          cwd: session.cwd,
          source,
        });
        if (reconciled) {
          continue;
        }
        await this.enqueue(run.runId, async () => {
          const latest = await this.getRun(run.runId);
          if (
            !latest ||
            latest.phase !== "executing" ||
            latest.status !== "running"
          ) {
            return;
          }
          if (this.hasObservedRecheckTimeout(latest)) {
            await this.handleTimedOutRechecks(latest);
          }
        });
      }
    }
  }

  private hasObservedRecheckTimeout(
    run: AgentTeamRun,
    nowMs = Date.now(),
  ): boolean {
    const dispatchId = run.activeWorkerDispatch?.dispatchId;
    const activeCases = findActiveRecheckCases(run);
    if (!dispatchId || activeCases.length === 0) {
      this.clearRecheckWatchdogClocks(run.runId);
      return false;
    }

    const clockKey = `${run.runId}:${dispatchId}`;
    const previous = this.recheckWatchdogClocks.get(clockKey);
    const observedGapMs = previous ? nowMs - previous.lastObservedAtMs : 0;
    const activeElapsedMs =
      previous &&
      observedGapMs >= 0 &&
      observedGapMs <= RECHECK_WATCHDOG_MAX_CONTINUOUS_GAP_MS
        ? previous.activeElapsedMs + observedGapMs
        : (previous?.activeElapsedMs ?? 0);

    this.clearRecheckWatchdogClocks(run.runId, clockKey);
    this.recheckWatchdogClocks.set(clockKey, {
      lastObservedAtMs: nowMs,
      activeElapsedMs,
    });
    return activeElapsedMs >= RECHECK_TIMEOUT_MS;
  }

  private clearRecheckWatchdogClocks(runId: string, keepKey?: string): void {
    const prefix = `${runId}:`;
    for (const key of this.recheckWatchdogClocks.keys()) {
      if (key.startsWith(prefix) && key !== keepKey) {
        this.recheckWatchdogClocks.delete(key);
      }
    }
  }

  protected async handleTimedOutRechecks(
    run: AgentTeamRun,
  ): Promise<AgentTeamRun> {
    const overdueCases = findRecheckWatchdogCases(run);
    if (overdueCases.length === 0) {
      return run;
    }

    const exhaustedCases = overdueCases.filter(
      (item) => (item.recheckAttempt ?? 0) >= MAX_RECHECK_ATTEMPTS,
    );
    const retryCases = overdueCases.filter(
      (item) => (item.recheckAttempt ?? 0) < MAX_RECHECK_ATTEMPTS,
    );

    let latestRun = run;
    if (retryCases.length > 0) {
      latestRun = await this.retryTimedOutRechecks(latestRun, retryCases);
    }
    if (exhaustedCases.length === 0) {
      return latestRun;
    }
    return this.updateRun(latestRun, {
      status: "need_human",
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      workers: latestRun.workers.map((worker) => ({ ...worker, frozen: true })),
      acceptance: latestRun.acceptance.map((item) =>
        exhaustedCases.some((exhausted) => exhausted.caseId === item.caseId)
          ? {
              ...item,
              status: "fail" as const,
              consecutiveFail: latestRun.loop.stableFailThreshold,
              resultSummary: `复验 worker 连续 ${MAX_RECHECK_ATTEMPTS} 次未更新 outbox`,
              reproduction: null,
              evidence:
                item.evidence.length > 0
                  ? item.evidence
                  : [
                      {
                        type: "text" as const,
                        label: "复验超时",
                        summary: `worker ${item.recheckWorkerPanelId ?? "unknown"} 连续 ${MAX_RECHECK_ATTEMPTS} 次未更新 outbox`,
                        detail: `超过 ${RECHECK_TIMEOUT_MS / 1000}s 未产出复验结果，已升级人工处理。`,
                        ref: `recheck watchdog: worker ${item.recheckWorkerPanelId ?? "unknown"} did not update outbox within ${RECHECK_TIMEOUT_MS / 1000}s after ${MAX_RECHECK_ATTEMPTS} attempts`,
                      },
                    ],
              recheckRequestedAt: null,
              recheckDispatchId: null,
              recheckWorkerPanelId: null,
              recheckWorkerRole: null,
              recheckOutboxMtimeMs: null,
              recheckAttempt: 0,
            }
          : item,
      ),
      logs: [
        ...latestRun.logs,
        `⏸ 复验 worker 连续 ${MAX_RECHECK_ATTEMPTS} 次未产出 outbox，升级人工：${exhaustedCases.map((item) => item.caseId).join(", ")}`,
      ],
    });
  }

  protected async retryTimedOutRechecks(
    run: AgentTeamRun,
    cases: AgentTeamAcceptanceCase[],
  ): Promise<AgentTeamRun> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return run;
    }
    let latestRun = run;
    for (const group of groupRecheckCasesByWorker(cases)) {
      const worker =
        this.findRecheckWorker(latestRun, group[0]!) ??
        resolveRecheckDispatches(latestRun, [group[0]!])[0]?.worker ??
        null;
      if (!worker?.panelId) {
        continue;
      }
      const attempt =
        Math.max(...group.map((item) => item.recheckAttempt ?? 0)) + 1;
      try {
        latestRun = await this.sendRecheckToWorker(
          latestRun,
          session,
          worker,
          group,
          { attempt, reason: "timeout_retry" },
        );
      } catch (error) {
        agentTeamLogger.warn("agent-team.recheck_retry.failed", {
          message: "Could not dispatch timed-out recheck",
          runId: latestRun.runId,
          role: worker.role,
          panelId: worker.panelId,
          attempt,
          error,
        });
        latestRun = (await this.getRun(latestRun.runId)) ?? latestRun;
        latestRun = await this.markRecheckDispatchFailed(
          latestRun,
          session,
          worker,
          group,
          attempt,
        );
      }
    }
    return latestRun;
  }

  protected async markRecheckDispatchFailed(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    worker: AgentTeamWorker,
    cases: AgentTeamAcceptanceCase[],
    attempt: number,
  ): Promise<AgentTeamRun> {
    const now = new Date().toISOString();
    const caseIds = new Set(cases.map((item) => item.caseId));
    const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(session, worker);
    const activeWorkerDispatch = createActiveWorkerDispatch(
      worker,
      now,
      outboxMtimeMs,
      run.loop.round,
      worker.role === "code_review"
        ? (run.reviewCheckpoint?.pendingReview ?? null)
        : null,
    );
    return this.updateRun(run, {
      activeWorkerRole: worker.role,
      activeWorkerDispatch,
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
      workers: setActiveWorker(run.workers, worker.role),
      acceptance: run.acceptance.map((item) =>
        caseIds.has(item.caseId)
          ? {
              ...item,
              status: "pending" as const,
              resultSummary: null,
              reproduction: null,
              bouncedToPanelId: null,
              recheckRequestedAt: now,
              recheckDispatchId: activeWorkerDispatch.dispatchId ?? null,
              recheckWorkerPanelId: worker.panelId ?? null,
              recheckWorkerRole: worker.role,
              recheckOutboxMtimeMs: outboxMtimeMs,
              recheckAttempt: attempt,
            }
          : item,
      ),
      logs: [
        ...run.logs,
        `复验 worker ${worker.role} pane ${worker.panelId ?? ""} 投递失败，已记录 attempt ${attempt}：${Array.from(caseIds).join(", ")}`,
      ],
    });
  }

  protected findRecheckWorker(
    run: AgentTeamRun,
    acceptanceCase: AgentTeamAcceptanceCase,
  ): AgentTeamWorker | null {
    return (
      run.workers.find(
        (worker) =>
          worker.panelId === acceptanceCase.recheckWorkerPanelId ||
          worker.role === acceptanceCase.recheckWorkerRole,
      ) ?? null
    );
  }

  protected async readWorkerOutboxMtimeMs(
    session: TerminalSessionRecord,
    worker: Pick<AgentTeamWorker, "panelId" | "tmuxPaneId">,
  ): Promise<number | null> {
    try {
      const fileStat = await stat(
        this.paths.workerOutboxPath(
          session.projectId,
          session.id,
          worker,
          session.cwd,
        ),
      );
      return fileStat.mtimeMs;
    } catch {
      return null;
    }
  }

  protected resolveOutboxRound(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): {
    acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>;
    forceBounceCaseIds: string[];
    repairTargets: AgentTeamRepairTarget[];
  } {
    const runWithGates = {
      ...run,
      acceptance: ensureWorkerGateAcceptance(run.workers, run.acceptance),
    };
    const knownCaseIds = new Set(
      runWithGates.acceptance.map((item) => item.caseId),
    );
    const directResults = (outbox.acceptanceResults ?? []).filter((result) =>
      knownCaseIds.has(result.caseId),
    );
    const reviewResults = synthesizeBlockingReviewResults(runWithGates, outbox);
    if (reviewResults.length > 0) {
      return {
        acceptanceResults: reviewResults,
        forceBounceCaseIds: reviewResults.map((result) => result.caseId),
        repairTargets: resolveRepairTargets(
          runWithGates,
          outbox,
          reviewResults,
        ),
      };
    }
    if (
      outbox.role === "code_review" &&
      rawBlockingReviewFindings(outbox).length > 0
    ) {
      const reviewGate = runWithGates.acceptance.find(
        isReviewGateAcceptanceCase,
      );
      if (reviewGate) {
        return {
          acceptanceResults: [
            {
              caseId: reviewGate.caseId,
              status: "pass",
              summary: "阻断 finding 已由人工完成范围裁决",
              evidence: [
                {
                  type: "event",
                  label: "Finding 人工裁决",
                  summary: "非 blocking disposition 已记录，finding 事实仍保留",
                  ref: `finding-decisions:${run.runId}`,
                },
              ],
            },
          ],
          forceBounceCaseIds: [],
          repairTargets: [],
        };
      }
    }
    if (directResults.length > 0) {
      return {
        acceptanceResults: directResults,
        forceBounceCaseIds: isGateWorkerOutbox(outbox)
          ? directResults
              .filter((result) => result.status === "fail")
              .map((result) => result.caseId)
          : [],
        repairTargets: resolveRepairTargets(
          runWithGates,
          outbox,
          directResults,
        ),
      };
    }
    return { acceptanceResults: [], forceBounceCaseIds: [], repairTargets: [] };
  }
}
