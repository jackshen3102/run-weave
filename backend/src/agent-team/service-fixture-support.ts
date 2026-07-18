import type {
  AgentTeamOwnedFixtureCleanup,
  AgentTeamRun,
  AgentTeamRunLineage,
  AgentTeamRunKind,
  CreateAgentTeamRunRequest,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";
import { listOwnedAgentTeamDevSessions } from "./dev-session-fixture-registry";
import { cleanupAgentTeamFixtureResources } from "./fixture-resource-cleanup";
import {
  fixtureLineageMismatch,
  lineageFromEnvironmentFixtureScope,
} from "./fixture-scope";
import { isReviewGateAcceptanceCase } from "./service-acceptance-policy";
import { AgentTeamWorkerDispatchSupport } from "./service-worker-dispatch-support";

export class AgentTeamFixtureSupport extends AgentTeamWorkerDispatchSupport {
  protected async resolveRunFixtureIdentity(
    input: CreateAgentTeamRunRequest,
  ): Promise<{
    runKind: AgentTeamRunKind;
    lineage: AgentTeamRunLineage | null;
  }> {
    if (this.environmentFixtureScope) {
      if (input.runKind === "primary") {
        throw new AgentTeamError(
          409,
          "Fixture-scoped Backend cannot create an unowned primary Run",
        );
      }
      const expected = lineageFromEnvironmentFixtureScope(
        this.environmentFixtureScope,
      );
      const lineage = input.lineage
        ? {
            ...input.lineage,
            ownerDevSessionId:
              input.lineage.ownerDevSessionId ?? expected.ownerDevSessionId,
          }
        : expected;
      const mismatch = fixtureLineageMismatch(expected, lineage);
      if (mismatch) {
        throw new AgentTeamError(
          409,
          `Fixture lineage does not match Dev Session owner scope: ${mismatch}`,
        );
      }
      return { runKind: "verification_fixture", lineage };
    }
    if (!input.runKind || input.runKind === "primary") {
      if (input.lineage) {
        throw new AgentTeamError(
          400,
          "Primary Run must not declare fixture lineage",
        );
      }
      return { runKind: "primary", lineage: null };
    }
    if (!input.lineage) {
      throw new AgentTeamError(
        400,
        "verification_fixture Run requires lineage",
      );
    }
    await this.assertLocalFixtureLineage(input.lineage);
    return { runKind: "verification_fixture", lineage: input.lineage };
  }

  private async assertLocalFixtureLineage(
    lineage: AgentTeamRunLineage,
  ): Promise<void> {
    const owner = await this.runStore.getRun(lineage.ownerRunId);
    if (!owner) {
      throw new AgentTeamError(409, "Fixture owner Run does not exist");
    }
    const dispatch = owner.activeWorkerDispatch;
    const isBehaviorOwner =
      owner.phase === "executing" &&
      owner.status === "running" &&
      owner.activeWorkerRole === "behavior_verify" &&
      dispatch?.role === "behavior_verify" &&
      dispatch.dispatchId === lineage.ownerDispatchId;
    const runtimeRepairCaseIds = activeRuntimeRepairCaseIds(
      owner,
      lineage.ownerDispatchId,
      lineage.ownerDevSessionId ?? null,
    );
    const isRuntimeRepairOwner =
      owner.phase === "executing" &&
      owner.status === "running" &&
      owner.activeWorkerRole === "code" &&
      dispatch?.role === "code" &&
      dispatch.dispatchId === lineage.ownerDispatchId &&
      runtimeRepairCaseIds.length > 0;
    if (!isBehaviorOwner && !isRuntimeRepairOwner) {
      throw new AgentTeamError(
        409,
        "Fixture owner dispatch is not the active behavior_verify or runtime code repair dispatch",
      );
    }
    const allowedCases = new Set(
      isRuntimeRepairOwner
        ? runtimeRepairCaseIds
        : (() => {
            const dispatchCases = owner.acceptance.filter(
              (item) => item.recheckDispatchId === lineage.ownerDispatchId,
            );
            return (dispatchCases.length > 0
              ? dispatchCases
              : owner.acceptance.filter(
                  (item) => !isReviewGateAcceptanceCase(item),
                )
            ).map((item) => item.caseId);
          })(),
    );
    if (
      lineage.ownerCaseIds.length === 0 ||
      lineage.ownerCaseIds.some((caseId) => !allowedCases.has(caseId))
    ) {
      throw new AgentTeamError(
        409,
        "Fixture ownerCaseIds are outside the active fixture dispatch",
      );
    }
    if (
      !lineage.fixtureNamespace.startsWith(
        `agent-team:${lineage.ownerRunId}:${lineage.ownerDispatchId}:`,
      )
    ) {
      throw new AgentTeamError(
        409,
        "Fixture namespace does not match its owner Run and dispatch",
      );
    }
    if (lineage.ownsTerminalSession) {
      throw new AgentTeamError(
        409,
        "Exclusive terminal ownership must come from a fixture-scoped Dev Session",
      );
    }
  }

  protected assertEnvironmentFixtureScopeAccess(
    ownerRunId: string,
    ownerDispatchId: string | null | undefined,
  ): void {
    if (!this.environmentFixtureScope) return;
    if (
      ownerRunId !== this.environmentFixtureScope.ownerRunId ||
      ownerDispatchId !== this.environmentFixtureScope.ownerDispatchId
    ) {
      throw new AgentTeamError(
        409,
        "Fixture-scoped Backend can only access its exact owner dispatch",
      );
    }
  }

  protected async cancelOwnedFixtureRun(
    run: AgentTeamRun,
    reason: string,
    source: "api" | "owner_cleanup",
    cleanupResources: boolean,
  ): Promise<AgentTeamRun> {
    if (run.runKind !== "verification_fixture" || !run.lineage) {
      throw new AgentTeamError(409, "Only owned fixture Runs can be cancelled");
    }
    if (this.environmentFixtureScope) {
      const expected = lineageFromEnvironmentFixtureScope(
        this.environmentFixtureScope,
      );
      const mismatch = fixtureLineageMismatch(expected, run.lineage);
      if (mismatch) {
        throw new AgentTeamError(
          409,
          `Fixture-scoped Backend cannot cancel another owner scope: ${mismatch}`,
        );
      }
    }
    let latest = run;
    if (!isTerminalAgentTeamStatus(run.status)) {
      latest = await this.updateRun(run, {
        status: "cancelled",
        workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
        activeWorkerRole: null,
        activeWorkerDispatch: null,
        cancellation: { reason, requestedAt: new Date().toISOString(), source },
        logs: [...run.logs, `⏹ fixture 已取消：${reason}`],
      });
    }
    if (
      !cleanupResources ||
      latest.fixtureResourceCleanup?.status === "completed"
    ) {
      return latest;
    }
    const owner = await this.runStore.getRun(run.lineage.ownerRunId);
    const resourceCleanup = await cleanupAgentTeamFixtureResources(latest, {
      terminalSessionManager: this.terminalSessionManager,
      runtimeRegistry: this.runtimeRegistry,
      terminalEventService: this.terminalEventService,
      tmuxService: this.tmuxService,
      tmuxOutputWatcher: this.tmuxOutputWatcher,
      protectedTerminalSessionIds:
        owner?.terminalSessionId === latest.terminalSessionId
          ? new Set([owner.terminalSessionId])
          : undefined,
    });
    return this.updateRun(latest, {
      fixtureResourceCleanup: resourceCleanup,
      logs:
        resourceCleanup.status === "completed"
          ? [...latest.logs, "fixture 独占资源已回收"]
          : [
              ...latest.logs,
              `fixture 资源回收失败：${resourceCleanup.errors.join("; ")}`,
            ],
    });
  }

  protected async reconcileOwnedFixtureResources(
    owner: AgentTeamRun,
    ownerDispatchId: string | null,
    reason: string,
  ): Promise<AgentTeamOwnedFixtureCleanup> {
    const requestedAt = new Date().toISOString();
    const ownedRuns = (
      await this.runStore.listOwnedFixtureRuns(owner.runId, ownerDispatchId)
    ).filter(
      (fixture) =>
        ownerDispatchId == null ||
        fixture.lineage?.cleanupPolicy === "on_owner_dispatch_complete",
    );
    const cancelledRunIds: string[] = [];
    const errors: string[] = [];
    for (const fixture of ownedRuns) {
      const wasLive = !isTerminalAgentTeamStatus(fixture.status);
      try {
        const cleaned = await this.cancelOwnedFixtureRun(
          fixture,
          reason,
          "owner_cleanup",
          true,
        );
        if (wasLive && cleaned.status === "cancelled")
          cancelledRunIds.push(cleaned.runId);
        if (cleaned.fixtureResourceCleanup?.status === "failed") {
          errors.push(
            ...cleaned.fixtureResourceCleanup.errors.map(
              (error) => `${cleaned.runId}: ${error}`,
            ),
          );
        }
      } catch (error) {
        errors.push(
          `${fixture.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const afterCleanup = (
      await this.runStore.listOwnedFixtureRuns(owner.runId, ownerDispatchId)
    ).filter(
      (fixture) =>
        ownerDispatchId == null ||
        fixture.lineage?.cleanupPolicy === "on_owner_dispatch_complete",
    );
    const ownedLiveFixtureRunIds = afterCleanup
      .filter((run) => !isTerminalAgentTeamStatus(run.status))
      .map((run) => run.runId);
    const devSessions = await listOwnedAgentTeamDevSessions(
      owner.runId,
      ownerDispatchId,
      this.runtimeEnv,
    );
    errors.push(
      ...devSessions.flatMap((session) =>
        session.error ? [`${session.devSessionId}: ${session.error}`] : [],
      ),
    );
    const completed =
      ownedLiveFixtureRunIds.length === 0 && errors.length === 0;
    return {
      ownerDispatchId,
      requestedAt,
      completedAt: completed ? new Date().toISOString() : null,
      status: completed ? "completed" : "blocked",
      ownedRunIds: afterCleanup.map((run) => run.runId),
      cancelledRunIds,
      ownedLiveFixtureRunIds,
      devSessions,
      errors,
    };
  }
}

function activeRuntimeRepairCaseIds(
  owner: AgentTeamRun,
  dispatchId: string,
  devSessionId: string | null,
): string[] {
  const dispatch = owner.activeWorkerDispatch;
  if (
    !devSessionId ||
    dispatch?.dispatchId !== dispatchId ||
    dispatch.role !== "code"
  ) {
    return [];
  }
  const repairKeys = new Set(dispatch.repairKeys ?? []);
  const productCaseIds = new Set(
    owner.acceptance
      .filter((item) => !isReviewGateAcceptanceCase(item))
      .map((item) => item.caseId),
  );
  return Array.from(
    new Set(
      owner.loop.repairCycles
        .filter((cycle) => {
          const reproduction =
            cycle.sourceReproduction ?? cycle.finding?.reproduction;
          return (
            cycle.verificationMode === "runtime" &&
            repairKeys.has(cycle.repairKey) &&
            reproduction?.mode === "real_product" &&
            reproduction.status === "reproduced" &&
            reproduction.validationSessionId === devSessionId
          );
        })
        .flatMap((cycle) => cycle.caseIds)
        .filter((caseId) => productCaseIds.has(caseId)),
    ),
  );
}

export function isTerminalAgentTeamStatus(
  status: AgentTeamRun["status"],
): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}
