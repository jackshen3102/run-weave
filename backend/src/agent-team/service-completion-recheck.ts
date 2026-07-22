import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorker,
} from "@runweave/shared/agent-team";
import type { TerminalSessionRecord } from "../terminal/manager";
import { buildWorkerRecheckPrompt } from "./prompt-builders";
import { AgentTeamRepairProtocolService } from "./service-repair-protocol";
import { ensureWorkerGateAcceptance } from "./service-acceptance-policy";
import {
  createActiveWorkerDispatch,
  setActiveWorker,
} from "./service-workflow-policy";

export abstract class AgentTeamCompletionRecheckService extends AgentTeamRepairProtocolService {
  protected async sendRecheckToWorker(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    worker: AgentTeamWorker,
    cases: AgentTeamAcceptanceCase[],
    options: {
      attempt: number;
      sourcePanelId?: string | null;
      reason?: "timeout_retry";
      triggerSummary?: string | null;
    },
  ): Promise<AgentTeamRun> {
    if (!worker.panelId) {
      return run;
    }
    const outboxPath = this.paths.workerOutboxRelativePath(
      run.terminalSessionId,
      worker,
    );
    const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(session, worker);
    const now = new Date().toISOString();
    const activeWorkerDispatch = createActiveWorkerDispatch(
      worker,
      now,
      outboxMtimeMs,
      run.loop.round,
      worker.role === "code_review"
        ? (run.reviewCheckpoint?.pendingReview ?? null)
        : null,
      {
        environmentRecoveryProbe:
          run.activeWorkerDispatch?.environmentRecoveryProbe,
      },
    );
    const caseIds = new Set(cases.map((item) => item.caseId));
    const logPrefix =
      options.reason === "timeout_retry"
        ? `复验 worker 超时，已重试触发用例`
        : `code pane ${options.sourcePanelId ?? ""} 已完成，重新触发用例`;
    const persistedRun = await this.updateRun(run, {
      activeWorkerRole: worker.role,
      activeWorkerDispatch,
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
      workers: setActiveWorker(run.workers, worker.role),
      acceptance: ensureWorkerGateAcceptance(run.workers, run.acceptance).map(
        (item) =>
          caseIds.has(item.caseId)
            ? {
                ...item,
                latestObservation: null,
                status: "pending" as const,
                lastRunStatus: "pending" as const,
                skip: null,
                skipReason: null,
                consecutiveFail: 0,
                resultSummary: null,
                reproduction: null,
                bouncedToPanelId: null,
                recheckRequestedAt: now,
                recheckDispatchId: activeWorkerDispatch.dispatchId ?? null,
                recheckWorkerPanelId: worker.panelId,
                recheckWorkerRole: worker.role,
                recheckOutboxMtimeMs: outboxMtimeMs,
                recheckAttempt: options.attempt,
              }
            : item,
      ),
      logs: [
        ...run.logs,
        `${logPrefix} ${Array.from(caseIds).join(", ")} 复验（${worker.role} pane ${worker.panelId}，attempt ${options.attempt}）`,
      ],
    });
    const workerPrompt = buildWorkerRecheckPrompt({
      run: persistedRun,
      worker,
      cases,
      outboxPath,
      triggerSummary: options.triggerSummary ?? null,
    });
    await this.submitWorkerDispatchPrompt(
      persistedRun,
      session,
      run.terminal,
      worker,
      workerPrompt,
    );
    return persistedRun;
  }
}
