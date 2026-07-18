import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  DecideAgentTeamFindingRequest,
  InterveneAgentTeamRunRequest,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";
import {
  isTraceableProductCase,
  resolvePendingFindingDecision,
} from "./repair-loop";
import { AgentTeamRecheckService } from "./service-recheck";
import {
  acceptanceCasesForRole,
  ensureWorkerGateAcceptance,
  mergeAcceptanceRefresh,
} from "./service-acceptance-policy";

function selectAgentInterventionCases(
  eligibleCases: AgentTeamAcceptanceCase[],
  requestedCaseIds: string[] | undefined,
): AgentTeamAcceptanceCase[] {
  if (eligibleCases.length === 0) {
    throw new AgentTeamError(409, "目标 worker 当前没有可介入的 case");
  }
  if (!requestedCaseIds || requestedCaseIds.length === 0) {
    return eligibleCases;
  }
  const requested = new Set(requestedCaseIds);
  const selected = eligibleCases.filter((item) => requested.has(item.caseId));
  const selectedIds = new Set(selected.map((item) => item.caseId));
  const invalidCaseIds = requestedCaseIds.filter(
    (caseId) => !selectedIds.has(caseId),
  );
  if (invalidCaseIds.length > 0) {
    throw new AgentTeamError(
      400,
      `目标 worker 不拥有这些 case：${invalidCaseIds.join(", ")}`,
    );
  }
  return selected;
}

export class AgentTeamInterventionService extends AgentTeamRecheckService {
  async interveneRun(
    runId: string,
    input: InterveneAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    return this.enqueue(runId, async () => {
      const run = await this.requireRun(runId);
      this.assertFrameworkRepairNotBlocked(run);
      const supersedingActiveDispatch =
        input.action === "dispatch" &&
        run.status === "running" &&
        run.activeWorkerRole === input.role;
      const reopeningCompletedAcceptance =
        input.action === "refresh_acceptance" && run.status === "done";
      if (
        run.phase !== "executing" ||
        (run.status !== "need_human" &&
          !supersedingActiveDispatch &&
          !reopeningCompletedAcceptance)
      ) {
        throw new AgentTeamError(
          409,
          "Agent intervention 只允许处理 executing/need_human、恢复完成态验收，或显式覆盖当前同 role dispatch",
        );
      }
      if (run.pendingFindingDecision) {
        throw new AgentTeamError(
          409,
          "当前存在 P0/P1 finding 范围裁决，Agent 不得代替人工 disposition",
        );
      }
      const note = input.note.trim();
      const previousReason = run.loop.lastReason;
      const now = new Date().toISOString();

      if (input.action === "refresh_acceptance") {
        if (input.role === "code") {
          throw new AgentTeamError(
            400,
            "刷新验收合同后只能派发 code_review 或 behavior_verify",
          );
        }
        const explicitGeneratedTestCaseFilePath =
          input.generatedTestCaseFilePath;
        const generatedTestCaseFilePath =
          explicitGeneratedTestCaseFilePath ??
          run.verification?.generatedTestCaseFilePath;
        if (!generatedTestCaseFilePath) {
          throw new AgentTeamError(
            400,
            "refresh_acceptance 需要 generatedTestCaseFilePath",
          );
        }
        const prepared = await this.prepareAcceptanceRefresh(
          run,
          generatedTestCaseFilePath,
          !explicitGeneratedTestCaseFilePath,
        );
        const affectedCaseIds = input.caseIds ?? [];
        const acceptance = ensureWorkerGateAcceptance(
          run.workers,
          mergeAcceptanceRefresh(
            run.acceptance,
            ensureWorkerGateAcceptance(run.workers, prepared.acceptance),
            affectedCaseIds,
          ),
        );
        const affectedCases = selectAgentInterventionCases(
          acceptanceCasesForRole({ ...run, acceptance }, "behavior_verify"),
          affectedCaseIds,
        );
        const cases =
          input.role === "behavior_verify"
            ? affectedCases
            : acceptanceCasesForRole({ ...run, acceptance }, "code_review");
        const refreshedBestPassCount = acceptance.filter(
          (item) => item.status === "pass",
        ).length;
        const affectedSet = new Set(affectedCaseIds);
        const refreshedRun = await this.updateRun(run, {
          status: "running",
          activeWorkerRole: null,
          activeWorkerDispatch: null,
          workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
          verification: prepared.verification,
          acceptance,
          reviewCheckpoint: run.reviewCheckpoint
            ? {
                ...run.reviewCheckpoint,
                pendingReview: null,
                finalReviewedCommit: null,
              }
            : run.reviewCheckpoint,
          loop: {
            ...run.loop,
            noProgressCount: 0,
            escalated: false,
            lastReason: null,
            errorFingerprints: [],
            bestPassCount: refreshedBestPassCount,
            repairCycles: (run.loop.repairCycles ?? []).filter(
              (cycle) =>
                !cycle.caseIds.some((caseId) => affectedSet.has(caseId)),
            ),
          },
          agentInterventions: [
            ...(run.agentInterventions ?? []),
            {
              id: `agent_intervention_${Date.now()}`,
              at: now,
              action: input.action,
              note,
              role: input.role,
              caseIds: affectedCaseIds,
              previousReason,
              generatedTestCaseFilePath:
                prepared.verification.generatedTestCaseFilePath,
              checkpointAllowedDirtyPaths: input.checkpointAllowedDirtyPaths,
              checkpointExpectedHeadCommit: input.checkpointExpectedHeadCommit,
              checkpointRebasedCommit: input.checkpointRebasedCommit,
            },
          ],
          logs: [
            ...run.logs,
            ...(prepared.usedPersistedAcceptance ? [prepared.startLog] : []),
            `Agent 刷新验收合同：${prepared.verification.generatedTestCaseFilePath ?? generatedTestCaseFilePath}；影响 Case：${affectedCaseIds.join(", ")}`,
          ],
        });
        return this.dispatchSerialWorker(refreshedRun, input.role, {
          cases,
          log: "Agent intervention 刷新验收合同后重新派发",
          triggerSummary: note,
          reviewScope: input.role === "code_review" ? "full" : undefined,
          checkpointAllowedDirtyPaths: input.checkpointAllowedDirtyPaths,
          checkpointExpectedHeadCommit: input.checkpointExpectedHeadCommit,
          checkpointRebasedCommit: input.checkpointRebasedCommit,
        });
      }

      let cases: AgentTeamAcceptanceCase[];
      if (input.role === "code") {
        const repairCaseIds = new Set(
          (run.loop.repairCycles ?? []).flatMap((cycle) => cycle.caseIds),
        );
        const eligibleCases = run.acceptance.filter(
          (item) => item.status === "fail" && repairCaseIds.has(item.caseId),
        );
        cases = selectAgentInterventionCases(eligibleCases, input.caseIds);
      } else {
        cases = selectAgentInterventionCases(
          acceptanceCasesForRole(run, input.role),
          input.caseIds,
        );
      }
      const intervenedRun = await this.updateRun(run, {
        status: "running",
        activeWorkerRole: null,
        activeWorkerDispatch: null,
        workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
        loop: {
          ...run.loop,
          escalated: false,
          lastReason: null,
          repairCycles: [...(run.loop.repairCycles ?? [])],
        },
        agentInterventions: [
          ...(run.agentInterventions ?? []),
          {
            id: `agent_intervention_${Date.now()}`,
            at: now,
            action: input.action,
            note,
            role: input.role,
            caseIds: cases.map((item) => item.caseId),
            previousReason,
            checkpointAllowedDirtyPaths: input.checkpointAllowedDirtyPaths,
            checkpointExpectedHeadCommit: input.checkpointExpectedHeadCommit,
            checkpointRebasedCommit: input.checkpointRebasedCommit,
          },
        ],
        logs: [
          ...run.logs,
          ...(supersedingActiveDispatch
            ? [`Agent intervention 覆盖当前 ${input.role} dispatch`]
            : []),
          `Agent intervention 选择 ${input.role}：${cases.map((item) => item.caseId).join(", ")}`,
        ],
      });
      if (input.role === "code") {
        return this.bounceFailuresToCode(
          intervenedRun,
          cases.map((item) => item.caseId),
        );
      }
      return this.dispatchSerialWorker(intervenedRun, input.role, {
        cases,
        log: "Agent intervention 重新派发",
        triggerSummary: note,
        reviewScope: input.role === "code_review" ? "final" : undefined,
        checkpointAllowedDirtyPaths: input.checkpointAllowedDirtyPaths,
        checkpointExpectedHeadCommit: input.checkpointExpectedHeadCommit,
        checkpointRebasedCommit: input.checkpointRebasedCommit,
      });
    });
  }

  async decideFinding(
    runId: string,
    input: DecideAgentTeamFindingRequest,
  ): Promise<AgentTeamRun> {
    return this.enqueue(runId, async () => {
      const run = await this.requireRun(runId);
      const pending = run.pendingFindingDecision;
      if (!pending || run.status !== "need_human") {
        throw new AgentTeamError(409, "Run 没有待裁决 review finding");
      }
      const invariantKey = input.invariantKey.trim();
      if (pending.finding.invariantKey !== invariantKey) {
        throw new AgentTeamError(409, "Finding 已变化，请刷新后重新裁决");
      }
      const reason = input.reason.trim();
      if (!reason) {
        throw new AgentTeamError(400, "Finding 裁决原因不能为空");
      }
      const caseIds = Array.from(
        new Set(
          (input.caseIds ?? []).map((caseId) => caseId.trim()).filter(Boolean),
        ),
      );
      if (input.disposition !== "out_of_scope" && caseIds.length === 0) {
        throw new AgentTeamError(
          400,
          `${input.disposition} 裁决必须映射至少一个可追溯产品 Case`,
        );
      }
      const invalidCaseId = caseIds.find((caseId) => {
        const acceptanceCase = run.acceptance.find(
          (item) => item.caseId === caseId,
        );
        return !acceptanceCase || !isTraceableProductCase(acceptanceCase);
      });
      if (invalidCaseId) {
        throw new AgentTeamError(400, `${invalidCaseId} 不是可追溯产品 Case`);
      }
      const now = new Date().toISOString();
      const decision = {
        id: `finding_decision_${Date.now()}`,
        invariantKey,
        scenarioId: pending.finding.reproduction?.scenarioId ?? null,
        finding: pending.finding,
        disposition: input.disposition,
        caseIds: input.disposition === "out_of_scope" ? [] : caseIds,
        reason,
        decidedAt: now,
        reviewTarget: pending.reviewTarget,
      };
      const repairKey = `code_review:${invariantKey}`;
      const decidedRun: AgentTeamRun = {
        ...run,
        status: "running",
        activeWorkerRole: null,
        activeWorkerDispatch: null,
        workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
        findingDecisions: [...(run.findingDecisions ?? []), decision],
        pendingFindingDecision: null,
        loop: {
          ...run.loop,
          noProgressCount: 0,
          escalated: false,
          lastReason: null,
          repairCycles: (run.loop.repairCycles ?? []).map((cycle) =>
            input.disposition === "blocking" && cycle.repairKey === repairKey
              ? { ...cycle, attempts: 0, caseIds }
              : cycle,
          ),
        },
        logs: [
          ...run.logs,
          `人工裁决 finding ${invariantKey}：${input.disposition}${caseIds.length > 0 ? `（${caseIds.join(", ")}）` : ""}；${reason}`,
        ],
        updatedAt: now,
      };
      const nextPending = resolvePendingFindingDecision(
        decidedRun,
        pending.outbox,
      );
      if (nextPending) {
        return this.updateRun(decidedRun, {
          status: "need_human",
          pendingFindingDecision: nextPending,
          loop: {
            ...decidedRun.loop,
            escalated: true,
            lastReason: nextPending.reason,
          },
        });
      }

      let continuationRun = decidedRun;
      let round = this.resolveOutboxRound(continuationRun, pending.outbox);
      if (
        continuationRun.reviewCheckpoint?.pendingReview &&
        round.acceptanceResults.length > 0 &&
        round.acceptanceResults.every((result) => result.status === "pass")
      ) {
        continuationRun = await this.finalizeReviewCheckpoint(
          continuationRun,
          pending.outbox,
        );
        if (continuationRun.status !== "running") {
          return continuationRun;
        }
        round = this.resolveOutboxRound(continuationRun, pending.outbox);
      }
      if (round.acceptanceResults.length === 0) {
        return this.pauseForRepairProtocolError(
          continuationRun,
          "人工裁决后 reviewer outbox 没有可消费的验收结果",
        );
      }
      return this.applyRound(continuationRun, {
        acceptanceResults: round.acceptanceResults,
        forceBounceCaseIds: round.forceBounceCaseIds,
        repairTargets: round.repairTargets,
        completedWorkerRole: "code_review",
        completedWorkerSummary: pending.outbox.summary,
      });
    });
  }
}
