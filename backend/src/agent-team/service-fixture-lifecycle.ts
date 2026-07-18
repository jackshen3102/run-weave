import type {
  AgentTeamFixtureScopeResponse,
  AgentTeamRun,
  CancelAgentTeamRunRequest,
  CleanupAgentTeamFixtureScopeRequest,
  CleanupAgentTeamFixtureScopeResponse,
} from "@runweave/shared/agent-team";
import { AgentTeamInterventionService } from "./service-intervention";
import { isTerminalAgentTeamStatus } from "./service-fixture-support";

export class AgentTeamFixtureLifecycleService extends AgentTeamInterventionService {
  async cancelRun(
    runId: string,
    input: CancelAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    return this.cancelOwnedFixtureRun(
      run,
      input.reason.trim(),
      "api",
      input.cleanupResources !== false,
    );
  }

  async listFixtureScope(
    ownerRunId: string,
    ownerDispatchId?: string | null,
  ): Promise<AgentTeamFixtureScopeResponse> {
    const scopedDispatchId =
      this.environmentFixtureScope && ownerDispatchId == null
        ? this.environmentFixtureScope.ownerDispatchId
        : ownerDispatchId;
    this.assertEnvironmentFixtureScopeAccess(ownerRunId, scopedDispatchId);
    const runs = await this.runStore.listOwnedFixtureRuns(
      ownerRunId,
      scopedDispatchId,
    );
    return {
      ownerRunId,
      ownerDispatchId: scopedDispatchId ?? null,
      runs,
      ownedLiveFixtureRuns: runs.filter(
        (run) => !isTerminalAgentTeamStatus(run.status),
      ).length,
    };
  }

  async cleanupFixtureScope(
    input: CleanupAgentTeamFixtureScopeRequest,
  ): Promise<CleanupAgentTeamFixtureScopeResponse> {
    this.assertEnvironmentFixtureScopeAccess(
      input.ownerRunId,
      input.ownerDispatchId,
    );
    const before = await this.runStore.listOwnedFixtureRuns(
      input.ownerRunId,
      input.ownerDispatchId,
    );
    const cancelledRunIds: string[] = [];
    const cleanupErrors: Array<{ runId: string; errors: string[] }> = [];
    for (const fixture of before) {
      const wasLive = !isTerminalAgentTeamStatus(fixture.status);
      try {
        const cleaned = await this.cancelOwnedFixtureRun(
          fixture,
          input.reason,
          "owner_cleanup",
          true,
        );
        if (wasLive && cleaned.status === "cancelled") {
          cancelledRunIds.push(cleaned.runId);
        }
        if (cleaned.fixtureResourceCleanup?.status === "failed") {
          cleanupErrors.push({
            runId: cleaned.runId,
            errors: cleaned.fixtureResourceCleanup.errors,
          });
        }
      } catch (error) {
        cleanupErrors.push({
          runId: fixture.runId,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }
    const scope = await this.listFixtureScope(
      input.ownerRunId,
      input.ownerDispatchId,
    );
    return { ...scope, cancelledRunIds, cleanupErrors };
  }
}
