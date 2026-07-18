import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTeamRun } from "@runweave/shared/agent-team";
import type {
  AppServerThreadDetailResponse,
  AppServerThreadRef,
} from "@runweave/shared/app-server-events";
import { resolveAgentTeamRoundAttribution } from "@runweave/shared/work-history";
import { ActivityEventFactory } from "../backend/src/activity/event-factory";
import { ActivityQueryService } from "../backend/src/activity/query-service";
import { ActivityStore } from "../backend/src/activity/activity-store";
import type { AgentTeamService } from "../backend/src/agent-team/service";
import { LowDbTerminalSessionStore } from "../backend/src/terminal/lowdb-store";
import { TerminalSessionManager } from "../backend/src/terminal/manager";
import type { AppServerHistoryGateway } from "../backend/src/work-history/app-server-history-gateway";
import { WorkHistoryService } from "../backend/src/work-history/work-history-service";

class FixtureGateway {
  activeReads = 0;
  maxActiveReads = 0;

  constructor(
    private readonly threads: AppServerThreadRef[],
    private readonly unavailable = false,
  ) {}

  async listThreads(options: {
    terminalSessionId?: string;
    after?: string | null;
    limit?: number;
  } = {}) {
    if (this.unavailable) throw new Error("fixture unavailable");
    const after = Number(options.after ?? 0);
    const filtered = this.threads.filter(
      (thread) =>
        (!options.terminalSessionId ||
          thread.terminalSessionId === options.terminalSessionId) &&
        Number(thread.lastEventId) > after,
    );
    return {
      threads: filtered.slice(0, options.limit ?? 500),
      latestEventId: this.threads.at(-1)?.lastEventId ?? null,
    };
  }

  async getThreadDetail(
    threadId: string,
  ): Promise<AppServerThreadDetailResponse> {
    if (this.unavailable) throw new Error("fixture unavailable");
    const thread = this.threads.find((item) => item.threadId === threadId);
    assert(thread);
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    this.activeReads -= 1;
    return {
      thread,
      availability: thread.agent === "codex" ? "available" : "provider_unsupported",
      ...(thread.agent === "codex"
        ? {
            detail: {
              provider: "codex" as const,
              threadId,
              preview: `preview ${threadId}`,
              status: "idle" as const,
              createdAt: thread.lastActivityAt,
              updatedAt: thread.updatedAt,
              turns: [
                {
                  id: `turn-${threadId}`,
                  status: "completed" as const,
                  itemsView: "full" as const,
                  itemCount: 2,
                  messages: [
                    { id: `user-${threadId}`, role: "user" as const, text: `ask ${threadId}` },
                    {
                      id: `assistant-${threadId}`,
                      role: "assistant" as const,
                      text: `answer ${threadId}`,
                    },
                  ],
                },
              ],
            },
          }
        : {}),
    };
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "runweave-work-history-"));
  const activityHome = path.join(root, "activity");
  const activityStore = await ActivityStore.create({
    databasePath: path.join(activityHome, "activity.sqlite"),
    env: {
      ...process.env,
      RUNWEAVE_ACTIVITY_TEST_MODE: "true",
      RUNWEAVE_ACTIVITY_HOME: activityHome,
    },
  });
  try {
    const terminalManager = new TerminalSessionManager(
      new LowDbTerminalSessionStore(path.join(root, "terminal-sessions.json")),
    );
    await terminalManager.initialize();
    const project = await terminalManager.createProject("Work History Fixture", root);
    const terminal = await terminalManager.createSession({
      projectId: project.id,
      command: "/bin/zsh",
      cwd: root,
    });
    const factsFactory = new ActivityEventFactory({
      producerName: "work-history-verifier",
      producerVersion: "1",
      producerInstanceId: "work-history-verifier",
      runtimeChannel: "dev",
      runtimeSurface: "backend",
    });
    await activityStore.record(
      Array.from({ length: 201 }, (_, index) =>
        factsFactory.create({
          eventName: "agent.response.observed",
          occurredAt: new Date(Date.now() + index).toISOString(),
          scope: {
            projectId: project.id,
            terminalSessionId: terminal.id,
            threadId: index % 2 === 0 ? "thread-a" : "thread-b",
          },
          payload: { index },
        }),
      ),
    );
    const baseTime = new Date().toISOString();
    const twoThreads = [
      threadRef("thread-a", "1", project.id, terminal.id, baseTime),
      threadRef("thread-b", "2", project.id, terminal.id, baseTime),
    ];
    const run = fixtureRun(project.id, terminal.id);
    const fixture = {
      ...structuredClone(run),
      runId: "work-history-fixture-run",
      runKind: "verification_fixture" as const,
      lineage: {
        ownerRunId: run.runId,
        ownerDispatchId: "dispatch-work-history",
        ownerCaseIds: ["AGT-WH-001"],
        ownerDevSessionId: "dvs-work-history",
        fixtureNamespace:
          "agent-team:work-history-run:dispatch-work-history:dvs-work-history",
        ownsTerminalSession: true,
        cleanupPolicy: "on_owner_dispatch_complete" as const,
      },
      status: "cancelled" as const,
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const agentTeamService = {
      listRuns: async (projectId: string) =>
        projectId === project.id ? [fixture, run] : [],
      getRun: async (runId: string) =>
        runId === run.runId ? run : runId === fixture.runId ? fixture : null,
    } as unknown as AgentTeamService;
    const gateway = new FixtureGateway(twoThreads);
    const service = new WorkHistoryService(
      terminalManager,
      new ActivityQueryService(activityStore),
      gateway as unknown as AppServerHistoryGateway,
      agentTeamService,
    );

    const terminalPage = await service.listTerminals({ limit: 100 });
    assert.equal(terminalPage.terminals.length, 1);
    assert.equal(terminalPage.terminals[0]?.terminalSessionId, terminal.id);
    assert.equal(terminalPage.terminals[0]?.knownThreadCount, 2);
    const firstDetail = await service.getTerminal(terminal.id);
    assert(firstDetail);
    assert.deepEqual(
      firstDetail.threadRefs.map((thread) => thread.threadId),
      ["thread-a", "thread-b"],
    );
    assert.equal(firstDetail.threadDetails.length, 2);
    assert.equal(firstDetail.facts.facts.length, 200);
    assert(firstDetail.facts.nextCursor);
    const frozenOffset = firstDetail.asOfActivityOffset;

    await activityStore.record([
      factsFactory.create({
        eventName: "agent.response.observed",
        scope: { projectId: project.id, terminalSessionId: terminal.id },
        payload: { insertedAfterSnapshot: true },
      }),
    ]);
    const secondDetail = await service.getTerminal(terminal.id, {
      activityCursor: firstDetail.facts.nextCursor,
      asOfActivityOffset: frozenOffset,
      includeThreadDetails: false,
    });
    assert(secondDetail);
    assert.equal(secondDetail.asOfActivityOffset, frozenOffset);
    assert.equal(secondDetail.facts.facts.length, 1);
    assert.equal(secondDetail.facts.facts[0]?.payload.insertedAfterSnapshot, undefined);

    const unavailableService = new WorkHistoryService(
      terminalManager,
      new ActivityQueryService(activityStore),
      new FixtureGateway([], true) as unknown as AppServerHistoryGateway,
      agentTeamService,
    );
    const degraded = await unavailableService.getTerminal(terminal.id);
    assert(degraded);
    assert.equal(degraded.terminal.terminalSessionId, terminal.id);
    assert.equal(degraded.sourceStatus.appServer.status, "unavailable");

    const manyThreads = Array.from({ length: 55 }, (_, index) =>
      threadRef(
        `thread-${String(index + 1).padStart(2, "0")}`,
        String(index + 1),
        project.id,
        terminal.id,
        baseTime,
      ),
    );
    const boundedGateway = new FixtureGateway(manyThreads);
    const boundedService = new WorkHistoryService(
      terminalManager,
      new ActivityQueryService(activityStore),
      boundedGateway as unknown as AppServerHistoryGateway,
      agentTeamService,
    );
    const bounded = await boundedService.getTerminal(terminal.id, {
      includeActivity: false,
    });
    assert(bounded);
    assert.equal(bounded.threadDetails.length, 50);
    assert(bounded.nextThreadCursor);
    assert.equal(bounded.sourceStatus.appServer.status, "partial");
    assert(boundedGateway.maxActiveReads <= 4);
    const remaining = await boundedService.getTerminal(terminal.id, {
      threadCursor: bounded.nextThreadCursor,
      includeActivity: false,
    });
    assert.equal(remaining?.threadDetails.length, 5);
    assert.equal(remaining?.nextThreadCursor, undefined);

    const runPage = await service.listRuns({ limit: 1 });
    assert.equal(runPage.runs[0]?.nextRoundIndex, 3);
    assert.equal(runPage.runs[0]?.runKind, "primary");
    assert(runPage.nextCursor);
    const fixturePage = await service.listRuns({
      limit: 1,
      cursor: runPage.nextCursor,
    });
    assert.equal(fixturePage.runs[0]?.runId, fixture.runId);
    assert.equal(fixturePage.runs[0]?.ownerRunId, run.runId);
    assert.deepEqual(
      resolveAgentTeamRoundAttribution({ activityRound: 2, dispatchRound: 1 }),
      { round: 2, source: "activity_payload" },
    );
    assert.deepEqual(
      resolveAgentTeamRoundAttribution({ dispatchRound: 2 }),
      { round: 2, source: "dispatch_snapshot" },
    );
    assert.deepEqual(
      resolveAgentTeamRoundAttribution({ runLogRounds: [2, 2] }),
      { round: 2, source: "run_log_single_round" },
    );
    assert.deepEqual(
      resolveAgentTeamRoundAttribution({ runLogRounds: [1, 2] }),
      { round: null, source: "unavailable" },
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          terminalSessionId: terminal.id,
          knownThreadCount: 2,
          frozenOffset,
          maxThreadDetailConcurrency: boundedGateway.maxActiveReads,
          nextRoundIndex: run.loop.round,
          checks: [
            "terminal_archive_identity",
            "explicit_thread_ref_association",
            "activity_snapshot_pagination",
            "provider_unavailable_degradation",
            "thread_detail_limit_and_concurrency",
            "round_attribution_precedence",
            "primary_run_before_fixture_pagination",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await activityStore.close();
    await rm(root, { recursive: true, force: true });
  }
}

function threadRef(
  threadId: string,
  lastEventId: string,
  projectId: string,
  terminalSessionId: string,
  timestamp: string,
): AppServerThreadRef {
  return {
    threadId,
    agent: "codex",
    status: "idle",
    projectId,
    terminalSessionId,
    terminalPanelId: null,
    runId: null,
    cwd: null,
    identityStatus: "resolved",
    lifecycleStatus: "available",
    lastLifecycleType: "turn.completed",
    lastLifecycleCursor: lastEventId,
    sourceInstanceId: "fixture",
    lastEventId,
    lastHookEvent: "Stop",
    lastCompletionReason: "hook_stop",
    lastActivityAt: timestamp,
    updatedAt: timestamp,
  };
}

function fixtureRun(projectId: string, terminalSessionId: string): AgentTeamRun {
  const now = new Date().toISOString();
  return {
    runId: "work-history-run",
    projectId,
    terminalSessionId,
    phase: "executing",
    status: "running",
    options: { autoApproveSplit: true, notifyMainOnHumanGate: true },
    terminal: { command: "/bin/zsh", cwd: process.cwd() },
    task: "verify Work History",
    activeWorkerRole: null,
    activeWorkerDispatch: null,
    clarify: [],
    proposal: null,
    workers: [],
    acceptance: [],
    loop: {
      round: 3,
      noProgressCount: 0,
      maxNoProgress: 3,
      escalated: false,
      lastReason: null,
      stableFailThreshold: 2,
      errorFingerprints: [],
      bestPassCount: 0,
      repairCycles: [],
      maxRepairAttempts: 3,
    },
    humanNotes: [],
    logs: ["Round 1 dispatched", "Round 2 dispatched"],
    createdAt: now,
    updatedAt: now,
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
