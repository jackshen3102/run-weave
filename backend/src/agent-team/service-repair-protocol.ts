import type {
  AgentTeamRun,
  AgentTeamWorker,
} from "@runweave/shared/agent-team";
import { captureRepairSourceFingerprint } from "./repair-source-fingerprint";
import { AgentTeamSerialDispatchService } from "./service-serial-dispatch";
import { createActiveWorkerDispatch } from "./service-workflow-policy";

export abstract class AgentTeamRepairProtocolService extends AgentTeamSerialDispatchService {
  protected async handleProtocolCorrection(
    run: AgentTeamRun,
    worker: AgentTeamWorker,
    outboxMtimeMs: number | null,
    errors: string[],
    buildPrompt: (run: AgentTeamRun) => string,
    label: string,
  ): Promise<AgentTeamRun> {
    const dispatch = run.activeWorkerDispatch;
    if ((dispatch?.protocolCorrectionAttempt ?? 0) >= 1) {
      return this.pauseForRepairProtocolError(
        run,
        `${label} 连续两次不满足协议：${errors.join("；")}`,
      );
    }
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session || !worker.panelId) {
      return this.pauseForRepairProtocolError(
        run,
        `${label} 协议补交无法投递：worker pane 不可用`,
      );
    }
    let sourceFingerprint;
    try {
      sourceFingerprint = await captureRepairSourceFingerprint(
        this.resolveRequiredProjectRoot(run.projectId, session.cwd),
      );
    } catch (error) {
      return this.pauseForRepairProtocolError(
        run,
        `${label} 协议补交无法锁定源码边界：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const correctionDispatch = createActiveWorkerDispatch(
      worker,
      new Date().toISOString(),
      outboxMtimeMs,
      dispatch?.round ?? run.loop.round,
      dispatch?.reviewTarget ?? null,
      {
        repairKeys: dispatch?.repairKeys,
        protocolCorrectionAttempt: 1,
        protocolCorrectionSourceFingerprint: sourceFingerprint,
      },
    );
    const correctionRun = await this.updateRun(run, {
      activeWorkerDispatch: correctionDispatch,
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
      logs: [
        ...run.logs,
        `${label} 协议不完整，已要求原 worker 只补交 outbox：${errors.join("；")}`,
      ],
    });
    try {
      await this.promptSender.sendPromptToPane(
        session,
        buildPrompt(correctionRun),
        {
          panelId: worker.panelId,
        },
      );
    } catch (error) {
      return this.pauseForRepairProtocolError(
        correctionRun,
        `${label} 协议补交无法投递：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return correctionRun;
  }

  protected async pauseForRepairProtocolError(
    run: AgentTeamRun,
    reason: string,
  ): Promise<AgentTeamRun> {
    return this.updateRun(run, {
      status: "need_human",
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
      loop: {
        ...run.loop,
        repairCycles: [...(run.loop.repairCycles ?? [])],
        escalated: true,
        lastReason: reason,
      },
      logs: [...run.logs, `⏸ ${reason}`],
    });
  }
}
