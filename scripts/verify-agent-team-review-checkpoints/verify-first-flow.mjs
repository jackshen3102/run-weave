import { createInitialLoop } from "../../backend/src/agent-team/loop.ts";
import {
  withControlledStartupDelay,
  withHarness,
} from "./bootstrap-lifecycle-harness.mjs";
import { AgentTeamSerialDispatchHarness } from "./bootstrap-lifecycle-serial-harness.mjs";

function buildService(harness) {
  return new AgentTeamSerialDispatchHarness({
    terminalSessionManager: harness.manager,
    terminalEventService: { record() {}, subscribe() {} },
    ptyService: harness.options.ptyService,
    runtimeRegistry: harness.options.runtimeRegistry,
    terminalStateService: harness.options.terminalStateService,
    tmuxService: harness.tmuxService,
    cwd: harness.session.cwd,
  });
}

function behaviorCase(caseId) {
  return {
    caseId,
    sourceCaseId: caseId,
    sourceFilePath: "docs/testing/full-test-cases.md",
    text: `${caseId} behavior`,
    status: "pending",
    consecutiveFail: 0,
    evidence: [],
    bouncedToPanelId: null,
  };
}

function buildExecutingVerifyFirstRun(harness, overrides = {}) {
  const now = new Date().toISOString();
  return {
    runId: "atr_vf_fixture",
    projectId: harness.session.projectId,
    terminalSessionId: harness.session.id,
    phase: "executing",
    status: "running",
    options: {
      autoApproveSplit: true,
      notifyMainOnHumanGate: true,
      reviewCheckpointMode: "disabled",
      maxRepairAttempts: 3,
      flow: "verify_first",
    },
    terminal: { command: "codex", args: [], cwd: harness.session.cwd },
    task: "verify-first fixture",
    verification: null,
    reviewCheckpoint: null,
    activeWorkerRole: "behavior_verify",
    activeWorkerDispatch: null,
    clarify: [],
    proposal: null,
    workers: [
      { id: "code-worker", role: "code", intent: "fix",
        panelId: "code-panel", tmuxPaneId: "%1", frozen: true },
      { id: "review-worker", role: "code_review", intent: "review",
        panelId: "review-panel", tmuxPaneId: "%2", frozen: true },
      { id: "behavior-worker", role: "behavior_verify", intent: "verify",
        panelId: "behavior-panel", tmuxPaneId: "%3", frozen: false },
    ],
    acceptance: [behaviorCase("BSP-001")],
    loop: createInitialLoop(3, 1),
    humanNotes: [],
    logs: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Scenario 1: reversed entry — applySplit on a verify_first run makes the first
// active worker behavior_verify (real service + real tmux panes).
async function verifyReversedEntry(check, roots) {
  await withHarness(roots, async (harness) => {
    const service = buildService(harness);
    const workers = [
      { id: "code-worker", role: "code", intent: "fix" },
      { id: "review-worker", role: "code_review", intent: "review" },
      { id: "behavior-worker", role: "behavior_verify", intent: "verify" },
    ];
    const acceptance = [behaviorCase("BSP-001")];
    const run = {
      ...buildExecutingVerifyFirstRun(harness),
      phase: "proposal",
      activeWorkerRole: null,
      workers: [],
      acceptance: [],
      proposal: { summary: "fixture split", workers, acceptance, source: "agent" },
    };
    harness.setExecutePaneSends(false);
    await withControlledStartupDelay(async (clock) => {
      const split = service.split(run, workers, acceptance);
      await clock.waitForTimer(15_000);
      clock.advanceTo(10_000);
      const result = await split;
      const activeWorker = result.workers.find(
        (worker) => worker.role === result.activeWorkerRole,
      );
      check(
        "verify-first-split-starts-behavior-verify",
        result.phase === "executing" &&
          result.activeWorkerRole === "behavior_verify" &&
          activeWorker?.role === "behavior_verify" &&
          result.workers.filter((worker) => !worker.frozen).length === 1 &&
          result.workers.find((w) => w.role === "behavior_verify")?.frozen ===
            false,
        {
          activeWorkerRole: result.activeWorkerRole,
          workers: result.workers.map((w) => ({ role: w.role, frozen: w.frozen })),
        },
      );
    });
  });
}

// Scenario 2: first-pass all-green with zero code activity → run done, and the
// synthetic review gate is vacuously passed (no diff to review).
async function verifyFirstPassAllGreenCompletes(check, roots) {
  await withHarness(roots, async (harness) => {
    const service = buildService(harness);
    const run = buildExecutingVerifyFirstRun(harness);
    harness.setExecutePaneSends(false);
    const result = await service.round(run, {
      acceptanceResults: [
        { caseId: "BSP-001", status: "pass", summary: "ok", evidence: [] },
      ],
      completedWorkerRole: "behavior_verify",
      completedWorkerSummary: "all green",
    });
    const reviewGate = result.acceptance.find((c) => c.caseId === "AGT-REVIEW-GATE");
    const behavior = result.acceptance.find((c) => c.caseId === "BSP-001");
    check(
      "verify-first-first-pass-all-green-completes",
      result.status === "done" &&
        result.activeWorkerRole === null &&
        behavior?.status === "pass" &&
        reviewGate?.status === "pass" &&
        service.secondaryPrompts.length === 0,
      {
        status: result.status,
        acceptance: result.acceptance.map((c) => ({ caseId: c.caseId, status: c.status })),
      },
    );
  });
}

// Scenario 3 (contrast): when code/code_review dispatches were already consumed,
// the review gate is NOT auto-passed — the run must not silently finish without
// a real code_review. Proves the vacuous-pass guard is scoped to no-code runs.
async function verifyReviewGateNotBypassedAfterCodeActivity(check, roots) {
  await withHarness(roots, async (harness) => {
    const service = buildService(harness);
    const run = buildExecutingVerifyFirstRun(harness, {
      consumedWorkerDispatches: [
        {
          dispatchId: "code-dispatch-1",
          role: "code",
          round: 1,
          contentSha256: "fixture",
          consumedAt: "2026-07-16T00:00:00.000Z",
        },
        {
          dispatchId: "review-dispatch-1",
          role: "code_review",
          round: 1,
          contentSha256: "fixture",
          consumedAt: "2026-07-16T00:01:00.000Z",
        },
      ],
      loop: {
        ...createInitialLoop(3, 1),
        repairCycles: [
          {
            repairKey: "behavior_verify:BSP-001",
            sourceRole: "behavior_verify",
            caseIds: ["BSP-001"],
            invariant: "BSP-001 behavior",
            verificationMode: "runtime",
            attempts: 1,
            maxAttempts: 3,
            firstFailedRound: 1,
            lastFailedRound: 1,
            lastFailureSummary: "was failing",
          },
        ],
      },
    });
    harness.setExecutePaneSends(false);
    const result = await service.round(run, {
      acceptanceResults: [
        { caseId: "BSP-001", status: "pass", summary: "fixed", evidence: [] },
      ],
      completedWorkerRole: "behavior_verify",
      completedWorkerSummary: "behavior green after fix",
    });
    const reviewGate = result.acceptance.find((c) => c.caseId === "AGT-REVIEW-GATE");
    check(
      "verify-first-review-gate-not-bypassed-after-code-activity",
      result.status !== "done" && reviewGate?.status !== "pass",
      {
        status: result.status,
        reviewGateStatus: reviewGate?.status,
        acceptance: result.acceptance.map((c) => ({ caseId: c.caseId, status: c.status })),
      },
    );
  });
}

export async function verifyVerifyFirstFlow(check, roots) {
  await verifyReversedEntry(check, roots);
  await verifyFirstPassAllGreenCompletes(check, roots);
  await verifyReviewGateNotBypassedAfterCodeActivity(check, roots);
}
