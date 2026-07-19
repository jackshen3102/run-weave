import { randomUUID } from "node:crypto";
import {
  resolveAgentTeamAcceptanceDecision,
  resolveAgentTeamAcceptanceObservedOutcome,
  type AgentTeamAcceptanceDisposition,
  type AgentTeamRun,
  type CompleteAgentTeamRunRequest,
  type DecideAgentTeamAcceptanceRequest,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";
import { isTraceableProductCase } from "./repair-loop";
import { acceptanceCasesForRole } from "./service-acceptance-policy";
import {
  appendAgentTeamCompletionOutcome,
  evaluateAgentTeamCompletion,
  projectAgentTeamRunForRead,
} from "./service-completion-policy";
import { AgentTeamFixtureLifecycleService } from "./service-fixture-lifecycle";

export class AgentTeamRunCompletionService extends AgentTeamFixtureLifecycleService {
  async completeRun(
    runId: string,
    input: CompleteAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    return this.enqueue(runId, () => this.completeRunUnlocked(runId, input));
  }

  async decideAcceptance(
    runId: string,
    input: DecideAgentTeamAcceptanceRequest,
  ): Promise<AgentTeamRun> {
    return this.enqueue(runId, async () => {
      const storedRun = await this.requireRun(runId);
      if (
        storedRun.phase !== "executing" ||
        storedRun.status !== "need_human" ||
        storedRun.activeWorkerRole ||
        storedRun.activeWorkerDispatch
      ) {
        throw new AgentTeamError(
          409,
          "只有等待人工处理且没有 active dispatch 的 Run 可以裁决验收 Case",
        );
      }
      if (storedRun.pendingFindingDecision) {
        throw new AgentTeamError(409, "请先完成待处理的 review finding 裁决");
      }
      const run = projectAgentTeamRunForRead(storedRun);
      const caseId = input.caseId.trim();
      const acceptanceCase = run.acceptance.find(
        (item) => item.caseId === caseId,
      );
      if (!acceptanceCase || !isTraceableProductCase(acceptanceCase)) {
        throw new AgentTeamError(400, `${caseId} 不是可裁决的产品 Case`);
      }
      const observation = acceptanceCase.latestObservation;
      if (!observation || observation.outcome === "pass") {
        throw new AgentTeamError(
          409,
          `${caseId} 没有可裁决的未通过 observation`,
        );
      }
      if (resolveAgentTeamAcceptanceDecision(run, acceptanceCase)) {
        throw new AgentTeamError(
          409,
          `${caseId} 的当前 observation 已完成人工裁决`,
        );
      }
      if (
        input.disposition === "accepted_environment_skip" &&
        (observation.outcome !== "skipped" ||
          acceptanceCase.skip?.code !== "environment")
      ) {
        throw new AgentTeamError(
          409,
          `${caseId} 不是结构化 environment skip，不能确认环境跳过`,
        );
      }
      const reason = input.reason.trim();
      if (!reason) {
        throw new AgentTeamError(400, "验收 Case 裁决原因不能为空");
      }
      const now = new Date().toISOString();
      const decisionId = `acceptance_decision_${randomUUID()}`;
      const decision = {
        id: decisionId,
        caseId,
        disposition: input.disposition,
        reason,
        observation: { ...observation },
        decidedAt: now,
      };
      const acceptanceDecisions = [
        ...(run.acceptanceDecisions ?? []),
        decision,
      ];
      const decidedSnapshot = { ...run, acceptanceDecisions };
      const resolvedCaseIds = new Set(
        run.acceptance
          .filter(
            (item) =>
              resolveAgentTeamAcceptanceObservedOutcome(item) === "pass" ||
              Boolean(
                resolveAgentTeamAcceptanceDecision(decidedSnapshot, item),
              ),
          )
          .map((item) => item.caseId),
      );
      const repairCycles = (run.loop.repairCycles ?? []).flatMap((cycle) => {
        const caseIds = cycle.caseIds.filter(
          (item) => !resolvedCaseIds.has(item),
        );
        return caseIds.length > 0 ? [{ ...cycle, caseIds }] : [];
      });
      const frameworkRepairResolved =
        run.frameworkRepair?.result === "blocked" &&
        run.frameworkRepair.target.caseIds.every((item) =>
          resolvedCaseIds.has(item),
        );
      const frameworkRepair =
        frameworkRepairResolved && run.frameworkRepair
          ? {
              ...run.frameworkRepair,
              result: "continued" as const,
              pendingContinueDispatchId: null,
              continuedAt: now,
              continuedDispatchId: null,
            }
          : run.frameworkRepair;
      const dispositionLabel: Record<AgentTeamAcceptanceDisposition, string> = {
        accepted_environment_skip: "确认环境问题并跳过",
        invalid_case: "标记 Case 不适用",
      };
      const decidedRun = await this.updateRun(storedRun, {
        status: "need_human",
        acceptance: run.acceptance,
        acceptanceDecisions,
        frameworkRepair,
        loop: {
          ...run.loop,
          repairCycles,
          escalated: true,
          lastReason: null,
        },
        logs: [
          ...run.logs,
          `人工裁决验收 Case ${caseId}：${dispositionLabel[input.disposition]}；${reason}`,
          ...(frameworkRepairResolved
            ? ["人工裁决已解决框架修复关联 Case，解除 framework repair 阻断"]
            : []),
        ],
      });
      const evaluation = evaluateAgentTeamCompletion(decidedRun);
      if (evaluation.ready) {
        return this.completeRunUnlocked(runId, {});
      }
      if (
        evaluation.blockers.length === 1 &&
        evaluation.blockers[0]?.code === "final_review"
      ) {
        return this.dispatchSerialWorker(
          {
            ...decidedRun,
            status: "running",
            loop: { ...decidedRun.loop, escalated: false, lastReason: null },
          },
          "code_review",
          {
            cases: acceptanceCasesForRole(decidedRun, "code_review"),
            log: "人工裁决后产品 Case 已收口，启动最终全量 code_review",
            triggerSummary: `验收 Case ${caseId} 已人工裁决`,
            reviewScope: "final",
          },
        );
      }
      return this.updateRun(decidedRun, {
        loop: {
          ...decidedRun.loop,
          escalated: true,
          lastReason: evaluation.blockers
            .map((blocker) => blocker.message)
            .join("；"),
        },
      });
    });
  }

  private async completeRunUnlocked(
    runId: string,
    input: CompleteAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    this.assertFrameworkRepairNotBlocked(run);
    if (run.phase !== "executing") {
      throw new AgentTeamError(409, "Run is not executing");
    }
    if (run.status === "done") {
      return projectAgentTeamRunForRead(run);
    }
    if (run.status === "failed") {
      throw new AgentTeamError(409, "Run has already failed");
    }
    if (run.status === "cancelled") {
      throw new AgentTeamError(
        409,
        "Cancelled fixture Run cannot be completed",
      );
    }
    const completionEvaluation = evaluateAgentTeamCompletion(run);
    if (!completionEvaluation.ready) {
      throw new AgentTeamError(
        409,
        `Run 尚未满足完成条件：${completionEvaluation.blockers
          .map((blocker) => blocker.message)
          .join("；")}`,
      );
    }
    const note = input.note?.trim();
    let fixtureCleanupHistory = run.fixtureCleanupHistory ?? [];
    if ((run.runKind ?? "primary") === "primary") {
      const cleanup = await this.reconcileOwnedFixtureResources(
        run,
        null,
        `owner Run ${run.runId} requested completion`,
      );
      fixtureCleanupHistory = [...fixtureCleanupHistory, cleanup];
      if (cleanup.status !== "completed") {
        const reason = formatFixtureCleanupBlocker(cleanup);
        return this.updateRun(run, {
          status: "need_human",
          workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
          activeWorkerRole: null,
          activeWorkerDispatch: null,
          fixtureCleanupHistory,
          loop: {
            ...run.loop,
            escalated: true,
            lastReason: reason,
          },
          logs: [...run.logs, `⏸ ${reason}`],
        });
      }
    }
    const now = new Date().toISOString();
    const completionPatch = appendAgentTeamCompletionOutcome(run, {
      id: randomUUID(),
      result: completionEvaluation.result,
      exceptions: completionEvaluation.exceptions,
      trigger: "operator_finalize",
      finalizedAt: now,
    });
    return this.updateRun(run, {
      status: "done",
      ...completionPatch,
      workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      loop: {
        ...run.loop,
        escalated: false,
        lastReason: null,
      },
      humanNotes: note
        ? [
            ...run.humanNotes,
            {
              id: `note_${Date.now()}`,
              at: now,
              text: note,
              clearedFingerprints: [...run.loop.errorFingerprints],
            },
          ]
        : run.humanNotes,
      fixtureCleanupHistory,
      logs: [
        ...run.logs,
        note ? `✅ 人工确认完成：${note}` : "✅ 人工确认完成，loop 已结束",
      ],
    });
  }
}

function formatFixtureCleanupBlocker(
  cleanup: NonNullable<AgentTeamRun["fixtureCleanupHistory"]>[number],
): string {
  const liveRuns = cleanup.ownedLiveFixtureRunIds.length;
  const blockedSessions = cleanup.devSessions.filter(
    (session) => session.error,
  ).length;
  return `fixture cleanup 未归零：ownedLiveFixtureRuns=${liveRuns}，blockedDevSessions=${blockedSessions}${cleanup.errors.length > 0 ? `；${cleanup.errors.join("; ")}` : ""}`;
}
