import type {
  AgentTeamRun,
  AgentTeamWorker,
} from "@runweave/shared/agent-team";
import {
  acceptanceCasesForRole,
  behaviorVerificationCasesForDispatch,
} from "./service-acceptance-policy";
import { AgentTeamCompletionSignalService } from "./service-completion-signal";

export abstract class AgentTeamCompletionRecoveryService extends AgentTeamCompletionSignalService {
  protected async recoverMissingActiveWorkerDispatch(
    run: AgentTeamRun,
    activeWorker: AgentTeamWorker,
  ): Promise<void> {
    const recoveryMarker = `dispatch-id-v1 activeWorkerDispatch 自动重建：${activeWorker.role} round ${run.loop.round}`;
    const recoveryCases =
      activeWorker.role === "behavior_verify"
        ? behaviorVerificationCasesForDispatch(run)
        : acceptanceCasesForRole(run, activeWorker.role).filter(
            (item) => item.status !== "pass",
          );
    if (recoveryCases.length > 0 && !run.logs.includes(recoveryMarker)) {
      await this.dispatchSerialWorker(
        {
          ...run,
          logs: [...run.logs, recoveryMarker],
        },
        activeWorker.role,
        {
          cases: recoveryCases,
          log: "dispatch-id-v1 缺少 activeWorkerDispatch，已自动建立 fresh dispatch",
          triggerSummary:
            "控制面检测到 active worker 缺少 dispatch；忽略当前无法绑定身份的 completion，并使用新的 dispatchId 与 outbox baseline 重新投递。",
        },
      );
      return;
    }
    await this.pauseForRepairProtocolError(
      run,
      recoveryCases.length === 0
        ? "dispatch-id-v1 run 缺少 activeWorkerDispatch，且没有可安全重派的未通过 Case"
        : "dispatch-id-v1 run 缺少 activeWorkerDispatch，自动重建已在当前 round 尝试过，禁止重复投递或回退 legacy dispatch",
    );
  }
}
