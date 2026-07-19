import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolveAgentTeamAcceptanceObservedOutcome } from "../packages/shared/src/agent-team.ts";
import { foldRound } from "../backend/src/agent-team/loop.ts";
import {
  evaluateAgentTeamCompletion,
  projectAgentTeamRunForRead,
} from "../backend/src/agent-team/service-completion-policy.ts";
import { resetPersistedAcceptanceForRefresh } from "../backend/src/agent-team/service-acceptance-refresh-policy.ts";
import { AgentTeamService } from "../backend/src/agent-team/service.ts";
import { withHarness } from "./verify-agent-team-review-checkpoints/bootstrap-lifecycle-harness.mjs";

const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};

function acceptanceCase(caseId, outcome = "pending") {
  return {
    caseId,
    sourceCaseId: caseId,
    sourceFilePath: "docs/testing/agent-team/example.testplan.yaml",
    text:
      caseId === "AGT-REVIEW-GATE"
        ? "Code Review 未发现阻断性问题"
        : `Acceptance ${caseId}`,
    status: outcome === "pass" ? "pass" : "pending",
    lastRunStatus: outcome,
    latestObservation:
      outcome === "pass"
        ? {
            outcome: "pass",
            dispatchId: "dispatch_pass",
            recordedAt: "2026-07-19T00:00:00.000Z",
          }
        : null,
    skip: null,
    skipReason: null,
    resultSummary: null,
    consecutiveFail: 0,
    evidence: [],
  };
}

function runFixture(overrides = {}) {
  return {
    runId: "atr_completion_outcome",
    projectId: "project_1",
    terminalSessionId: "terminal_1",
    phase: "executing",
    status: "need_human",
    options: { autoApproveSplit: true, notifyMainOnHumanGate: false },
    terminal: {},
    task: "verify completion outcome",
    activeWorkerRole: null,
    activeWorkerDispatch: null,
    workerDispatchProtocolVersion: 1,
    consumedWorkerDispatches: [],
    clarify: [],
    proposal: null,
    workers: [],
    acceptance: [
      acceptanceCase("AGT-REVIEW-GATE", "pass"),
      acceptanceCase("ACO-PASS", "pass"),
    ],
    loop: {
      round: 1,
      noProgressCount: 0,
      maxNoProgress: 3,
      escalated: false,
      lastReason: null,
      stableFailThreshold: 1,
      errorFingerprints: [],
      bestPassCount: 2,
      repairCycles: [],
      maxRepairAttempts: 3,
    },
    humanNotes: [],
    logs: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

const dispatched = runFixture({
  status: "running",
  activeWorkerRole: "behavior_verify",
  activeWorkerDispatch: {
    dispatchId: "dispatch_skip",
    role: "behavior_verify",
  },
  acceptance: [acceptanceCase("ACO-SKIP")],
});
const folded = foldRound(dispatched, {
  recordedAt: "2026-07-19T00:01:00.000Z",
  acceptanceResults: [
    {
      caseId: "ACO-SKIP",
      status: "skipped",
      skip: {
        code: "environment",
        retryable: true,
        detail: "missing display",
      },
      evidence: [],
    },
  ],
});
check(
  "skip-observation-keeps-dispatch-and-does-not-become-pass",
  folded.acceptance[0].status === "pending" &&
    folded.acceptance[0].latestObservation?.outcome === "skipped" &&
    folded.acceptance[0].latestObservation?.dispatchId === "dispatch_skip",
);

const skipped = folded.acceptance[0];
const failed = {
  ...acceptanceCase("ACO-INVALID"),
  status: "fail",
  lastRunStatus: "fail",
  latestObservation: {
    outcome: "fail",
    dispatchId: "dispatch_fail",
    recordedAt: "2026-07-19T00:01:30.000Z",
  },
  resultSummary: "case contract is not applicable",
};
const blocked = evaluateAgentTeamCompletion(
  runFixture({
    acceptance: [acceptanceCase("AGT-REVIEW-GATE", "pass"), skipped],
  }),
);
check(
  "skipped-case-blocks-completion",
  !blocked.ready &&
    blocked.blockers.some(
      (item) =>
        item.code === "unresolved_acceptance" &&
        item.caseIds.includes("ACO-SKIP"),
    ),
);
check("all-pass-run-is-ready", evaluateAgentTeamCompletion(runFixture()).ready);

const acceptedEnvironmentDecision = {
  id: "acceptance_decision_environment",
  caseId: skipped.caseId,
  disposition: "accepted_environment_skip",
  reason: "operator confirmed missing display",
  observation: { ...skipped.latestObservation },
  decidedAt: "2026-07-19T00:02:00.000Z",
};
const decidedSkipRun = runFixture({
  acceptance: [acceptanceCase("AGT-REVIEW-GATE", "pass"), skipped],
  acceptanceDecisions: [acceptedEnvironmentDecision],
});
const decidedSkipEvaluation = evaluateAgentTeamCompletion(decidedSkipRun);
check(
  "human-environment-disposition-resolves-with-exception",
  decidedSkipEvaluation.ready &&
    decidedSkipEvaluation.result === "completed_with_exceptions" &&
    decidedSkipEvaluation.exceptions.some(
      (item) =>
        item.kind === "acceptance_disposition" &&
        item.decisionId === acceptedEnvironmentDecision.id,
    ),
);
check(
  "new-observation-invalidates-old-disposition",
  !evaluateAgentTeamCompletion({
    ...decidedSkipRun,
    acceptance: decidedSkipRun.acceptance.map((item) =>
      item.caseId === skipped.caseId
        ? {
            ...item,
            latestObservation: {
              ...item.latestObservation,
              dispatchId: "dispatch_retry",
              recordedAt: "2026-07-19T00:03:00.000Z",
            },
          }
        : item,
    ),
  }).ready,
);

const mutationReadSources = await Promise.all(
  [
    "../backend/src/agent-team/service-completion.ts",
    "../backend/src/agent-team/service-recheck.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
);
check(
  "mutation-paths-read-raw-store-not-read-projection",
  mutationReadSources.every((source) => !source.includes("this.getRun(")),
);

const reset = resetPersistedAcceptanceForRefresh([
  acceptanceCase("ACO-REFRESH", "pass"),
]);
check(
  "pending-reset-clears-observation",
  reset[0].status === "pending" && reset[0].latestObservation === null,
);

const legacyDone = runFixture({
  status: "done",
  acceptance: [acceptanceCase("AGT-REVIEW-GATE", "pass"), skipped],
});
const legacyBefore = structuredClone(legacyDone);
const projected = projectAgentTeamRunForRead(legacyDone);
check(
  "legacy-done-projects-exception-without-mutating-store-object",
  projected.completionOutcome?.result === "completed_with_exceptions" &&
    JSON.stringify(legacyDone) === JSON.stringify(legacyBefore),
);

const roots = [];
try {
  await withHarness(roots, async (harness) => {
    const service = new AgentTeamService({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const persisted = runFixture({
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      acceptance: [acceptanceCase("AGT-REVIEW-GATE", "pass"), skipped],
    });
    await service.runStore.writeRun(persisted);
    let writes = 0;
    let cleanupCalls = 0;
    const writeRun = service.runStore.writeRun.bind(service.runStore);
    service.runStore.writeRun = async (run) => {
      writes += 1;
      return writeRun(run);
    };
    service.reconcileOwnedFixtureResources = async () => {
      cleanupCalls += 1;
      throw new Error("cleanup must not run");
    };

    const before = structuredClone(
      await service.runStore.getRun(persisted.runId),
    );
    await assert.rejects(
      service.completeRun(persisted.runId, {}),
      /产品验收未通过：ACO-SKIP/,
    );
    check(
      "blocked-complete-is-zero-write-before-cleanup",
      writes === 0 &&
        cleanupCalls === 0 &&
        JSON.stringify(await service.runStore.getRun(persisted.runId)) ===
          JSON.stringify(before),
    );

    const [listed, byId, byTerminal] = await Promise.all([
      service.listRuns(persisted.projectId),
      service.getRun(persisted.runId),
      service.getRunByTerminalSession(
        persisted.projectId,
        persisted.terminalSessionId,
      ),
    ]);
    check(
      "three-read-boundaries-project-skip-without-write",
      writes === 0 &&
        [listed[0], byId, byTerminal].every(
          (run) =>
            resolveAgentTeamAcceptanceObservedOutcome(run.acceptance[1]) ===
            "skipped",
        ),
    );

    service.reconcileOwnedFixtureResources = async () => {
      cleanupCalls += 1;
      return { status: "completed" };
    };
    const decided = await service.decideAcceptance(persisted.runId, {
      caseId: "ACO-SKIP",
      disposition: "accepted_environment_skip",
      reason: "operator confirmed the missing display is environmental",
    });
    check(
      "environment-disposition-completes-without-rewriting-observation",
      decided.status === "done" &&
        decided.acceptance[1].latestObservation?.outcome === "skipped" &&
        decided.acceptance[1].status === "pending" &&
        decided.completionOutcome?.result === "completed_with_exceptions" &&
        decided.completionOutcome.exceptions.some(
          (item) => item.kind === "acceptance_disposition",
        ) &&
        cleanupCalls === 1,
    );

    const invalidCaseRun = runFixture({
      runId: "atr_invalid_case",
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      acceptance: [acceptanceCase("AGT-REVIEW-GATE", "pass"), failed],
    });
    await service.runStore.writeRun(invalidCaseRun);
    await assert.rejects(
      service.decideAcceptance(invalidCaseRun.runId, {
        caseId: failed.caseId,
        disposition: "accepted_environment_skip",
        reason: "not an environment skip",
      }),
      /不是结构化 environment skip/,
    );
    const invalidDecided = await service.decideAcceptance(
      invalidCaseRun.runId,
      {
        caseId: failed.caseId,
        disposition: "invalid_case",
        reason: "operator confirmed this case is not applicable",
      },
    );
    check(
      "invalid-case-disposition-completes-with-original-fail",
      invalidDecided.status === "done" &&
        invalidDecided.acceptance[1].latestObservation?.outcome === "fail" &&
        invalidDecided.acceptance[1].status === "fail" &&
        invalidDecided.completionOutcome?.result ===
          "completed_with_exceptions" &&
        cleanupCalls === 2,
    );

    const manuallyRecoverableRun = runFixture({
      runId: "atr_manual_framework_override",
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      acceptance: [
        acceptanceCase("AGT-REVIEW-GATE", "pass"),
        acceptanceCase("ACO-PASS", "pass"),
        skipped,
      ],
      loop: {
        ...runFixture().loop,
        repairCycles: [
          {
            repairKey: "behavior_verify:ACO-PASS",
            sourceRole: "behavior_verify",
            caseIds: ["ACO-PASS"],
            invariant: "already resolved case",
            verificationMode: "runtime",
            attempts: 1,
            maxAttempts: 3,
            firstFailedRound: 1,
            lastFailedRound: 1,
            lastFailureSummary: "stale repair state",
          },
          {
            repairKey: "behavior_verify:ACO-SKIP",
            sourceRole: "behavior_verify",
            caseIds: ["ACO-SKIP"],
            invariant: "environment unavailable",
            verificationMode: "runtime",
            attempts: 1,
            maxAttempts: 3,
            firstFailedRound: 1,
            lastFailedRound: 1,
            lastFailureSummary: "environment unavailable",
          },
        ],
      },
      frameworkRepair: {
        repairId: "framework_repair_manual_override",
        reason: "verification environment unavailable",
        begunAt: "2026-07-19T00:01:00.000Z",
        backendInstanceIdBefore: "backend_before",
        target: {
          role: "behavior_verify",
          caseIds: ["ACO-PASS", "ACO-SKIP"],
          panelId: null,
          tmuxPaneId: null,
          invalidatedDispatch: {
            dispatchId: "dispatch_invalidated",
            role: "behavior_verify",
            panelId: null,
            tmuxPaneId: null,
            round: 1,
            requestedAt: "2026-07-19T00:00:30.000Z",
            outboxMtimeMs: null,
          },
        },
        result: "blocked",
      },
    });
    await service.runStore.writeRun(manuallyRecoverableRun);
    const manuallyRecovered = await service.decideAcceptance(
      manuallyRecoverableRun.runId,
      {
        caseId: "ACO-SKIP",
        disposition: "accepted_environment_skip",
        reason: "operator accepts the environment limitation",
      },
    );
    check(
      "human-disposition-overrides-resolved-repair-blockers",
      manuallyRecovered.status === "done" &&
        manuallyRecovered.loop.repairCycles.length === 0 &&
        manuallyRecovered.frameworkRepair?.result === "continued" &&
        manuallyRecovered.completionOutcome?.result ===
          "completed_with_exceptions" &&
        cleanupCalls === 3,
    );
  });
} finally {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
}

console.log(
  JSON.stringify({ ok: true, checkCount: checks.length, checks }, null, 2),
);
