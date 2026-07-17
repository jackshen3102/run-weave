import { foldRound } from "../../backend/src/agent-team/loop.ts";
import { normalizeAgentTeamWorkerOutbox } from "../../backend/src/agent-team/outbox-resolver.ts";
import {
  foldRepairGateResult,
  incrementRepairAttempts,
  resolveMaxRepairAttempts,
  resolveRepairTargets,
  reviewFindingContractErrors,
  validateCodeFixHandoff,
} from "../../backend/src/agent-team/repair-loop.ts";
import { createActiveWorkerDispatch } from "../../backend/src/agent-team/service-workflow-policy.ts";
import {
  buildFixVerification,
  buildRepairEvidence,
  normalizeRepairOutbox,
} from "./repair-fixtures.mjs";
import { verifyDispatchProtocolChecks } from "./repair-loop-dispatch.mjs";

function buildReviewReproduction(overrides = {}) {
  return {
    mode: "review_harness",
    status: "confirmed",
    scenarioId: "review-finding-reproduction",
    steps: ["run the production manager transition"],
    expected: "the invariant remains satisfied",
    actual: "the invariant is violated",
    evidence: [buildRepairEvidence("review-reproduction")],
    ...overrides,
  };
}

export function verifyRepairLoopContinuation(check, context) {
  const {
    behaviorDispatchRun,
    behaviorFold,
    behaviorOutbox,
    behaviorTargets,
    repeatedStructuralCycle,
    repeatedStructuralRun,
    reviewFold,
    reviewOutbox,
    run,
    runtimeCycle,
    runtimeRun,
    structuralCycle,
    structuralRun,
  } = context;
  const notReproducedOutbox = normalizeRepairOutbox(repeatedStructuralRun, [
    buildFixVerification(repeatedStructuralCycle, {
      reproduction: {
        mode: "review_harness",
        status: "not_reproduced",
        scenarioId: "repeated-review-finding",
        evidence: [buildRepairEvidence("not-reproduced")],
      },
      verification: {
        status: "blocked",
        sameScenario: true,
        evidence: [],
      },
      impactedChecks: [],
      strategyAssessment:
        "按 reviewer 场景执行后未观察到该 invariant 违约，退回 reviewer 举证。",
    }),
  ]);
  check(
    "repair-code-not-reproduced-requests-reviewer-evidence",
    validateCodeFixHandoff(repeatedStructuralRun, notReproducedOutbox)
      .status === "reviewer_reproduction_required",
    notReproducedOutbox,
  );
  const mismatchedScenarioOutbox = normalizeRepairOutbox(
    repeatedStructuralRun,
    [
      buildFixVerification(repeatedStructuralCycle, {
        reproduction: {
          mode: "review_harness",
          status: "not_reproduced",
          scenarioId: "different-scenario",
          evidence: [buildRepairEvidence("wrong-scenario")],
        },
        verification: {
          status: "blocked",
          sameScenario: true,
          evidence: [],
        },
        impactedChecks: [],
        strategyAssessment: "执行的不是 reviewer 原场景。",
      }),
    ],
  );
  check(
    "repair-code-not-reproduced-must-use-reviewer-scenario",
    validateCodeFixHandoff(repeatedStructuralRun, mismatchedScenarioOutbox)
      .status === "invalid",
    mismatchedScenarioOutbox,
  );
  check(
    "repair-structural-handoff-valid",
    validateCodeFixHandoff(
      structuralRun,
      normalizeRepairOutbox(structuralRun, [
        buildFixVerification(structuralCycle),
      ]),
    ).status === "valid",
    structuralCycle,
  );
  const executableStructuralReproduction = {
    ...structuralCycle.sourceReproduction,
    mode: "review_harness",
    status: "reproduced",
    evidence: [
      buildRepairEvidence("original-harness"),
      {
        type: "code",
        label: "contract",
        summary: "expected structural contract",
        ref: "docs/architecture/contract.md:10-20",
      },
    ],
  };
  const executableStructuralCycle = {
    ...structuralCycle,
    sourceReproduction: executableStructuralReproduction,
  };
  const executableStructuralRun = {
    ...structuralRun,
    loop: {
      ...structuralRun.loop,
      repairCycles: [executableStructuralCycle],
    },
  };
  check(
    "repair-review-harness-accepts-reproduced-and-requires-executable-ref-only",
    validateCodeFixHandoff(
      executableStructuralRun,
      normalizeRepairOutbox(executableStructuralRun, [
        buildFixVerification(executableStructuralCycle, {
          reproduction: {
            mode: "review_harness",
            status: "reproduced",
            scenarioId: executableStructuralReproduction.scenarioId,
            evidence: [buildRepairEvidence("original-harness")],
          },
        }),
      ]),
    ).status === "valid",
    executableStructuralCycle,
  );
  check(
    "repair-structural-rejects-unrelated-harness",
    validateCodeFixHandoff(
      structuralRun,
      normalizeRepairOutbox(structuralRun, [
        buildFixVerification(structuralCycle, {
          reproduction: {
            mode: "review_harness",
            status: "confirmed",
            evidence: [buildRepairEvidence("unrelated-before")],
          },
          verification: {
            status: "pass",
            sameScenario: true,
            evidence: [buildRepairEvidence("unrelated-after")],
          },
        }),
      ]),
    ).status === "invalid",
    structuralCycle,
  );

  const invalidReviewOutbox = normalizeAgentTeamWorkerOutbox({
    ...reviewOutbox,
    remainingFindings: [
      {
        severity: "P1",
        status: "open",
        title: "missing contract",
        summary: "missing stable identity",
      },
    ],
  });
  check(
    "repair-new-review-finding-requires-stable-key",
    reviewFindingContractErrors(
      run,
      invalidReviewOutbox,
      invalidReviewOutbox.acceptanceResults,
    ).length === 3,
    invalidReviewOutbox,
  );

  const unreproducedRuntimeOutbox = normalizeAgentTeamWorkerOutbox({
    ...reviewOutbox,
    remainingFindings: [
      {
        severity: "P1",
        status: "open",
        title: "runtime inference only",
        summary: "an intermediate state looked suspicious",
        invariantKey: "readiness.runtime-inference",
        verificationMode: "runtime",
        reproduction: buildReviewReproduction({
          mode: "real_product",
          status: "not_reproduced",
          scenarioId: "runtime-inference",
        }),
      },
    ],
  });
  check(
    "repair-runtime-review-finding-requires-observable-reproduction",
    reviewFindingContractErrors(
      run,
      unreproducedRuntimeOutbox,
      unreproducedRuntimeOutbox.acceptanceResults,
    ).some((error) => error.includes("real_product + reproduced")),
    unreproducedRuntimeOutbox,
  );

  const secondTitleOutbox = normalizeAgentTeamWorkerOutbox({
    ...reviewOutbox,
    remainingFindings: [
      {
        ...reviewOutbox.remainingFindings[0],
        title: "new symptom, same invariant",
        summary: "backend still owns checkpoint index at a new call site",
      },
      {
        severity: "P1",
        status: "open",
        title: "readiness boundary",
        summary: "readiness must use an event boundary",
        invariantKey: "readiness.event-boundary",
        verificationMode: "runtime",
        reproduction: buildReviewReproduction({
          mode: "real_product",
          status: "reproduced",
          scenarioId: "readiness-event-boundary",
        }),
      },
    ],
  });
  const isolatedTargets = resolveRepairTargets(
    run,
    secondTitleOutbox,
    secondTitleOutbox.acceptanceResults,
  );
  check(
    "repair-review-invariant-keys-isolate-generic-case",
    isolatedTargets
      .map((target) => target.repairKey)
      .sort()
      .join(",") ===
      "code_review:checkpoint.index-ownership,code_review:readiness.event-boundary",
    isolatedTargets,
  );

  let budgetLoop = behaviorFold.loop;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    budgetLoop = incrementRepairAttempts(budgetLoop, [runtimeCycle.repairKey]);
  }
  const budgetRun = { ...run, loop: budgetLoop };
  const diffFold = foldRound(budgetRun, { hadDiff: true });
  const exhausted = foldRepairGateResult({
    loop: diffFold.loop,
    completedRole: "behavior_verify",
    acceptanceResults: behaviorOutbox.acceptanceResults,
    targets: behaviorTargets,
    round: 3,
  });
  check(
    "repair-diff-does-not-reset-budget",
    exhausted.loop.repairCycles[0]?.attempts === 3 &&
      exhausted.exhausted[0]?.repairKey === runtimeCycle.repairKey,
    exhausted,
  );
  check(
    "repair-budget-default-and-bounds",
    resolveMaxRepairAttempts(undefined) === 3 &&
      resolveMaxRepairAttempts(1) === 1 &&
      resolveMaxRepairAttempts(5) === 5 &&
      resolveMaxRepairAttempts(0) === 3 &&
      resolveMaxRepairAttempts(6) === 3,
    "repair budget bounds failed",
  );

  const secondAttemptCycle = { ...runtimeCycle, attempts: 1 };
  const secondAttemptRun = {
    ...runtimeRun,
    loop: { ...runtimeRun.loop, repairCycles: [secondAttemptCycle] },
  };
  check(
    "repair-second-attempt-requires-strategy-assessment",
    validateCodeFixHandoff(
      secondAttemptRun,
      normalizeRepairOutbox(secondAttemptRun, [
        buildFixVerification(secondAttemptCycle),
      ]),
    ).status === "invalid" &&
      validateCodeFixHandoff(
        secondAttemptRun,
        normalizeRepairOutbox(secondAttemptRun, [
          buildFixVerification(secondAttemptCycle, {
            strategyAssessment:
              "上一轮缺少事件边界，本轮调整状态所有权而非增加文案分支。",
          }),
        ]),
      ).status === "valid",
    secondAttemptCycle,
  );

  const multiRun = {
    ...run,
    loop: {
      ...reviewFold.loop,
      repairCycles: [runtimeCycle, structuralCycle],
    },
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[0],
      run.updatedAt,
      1,
      run.loop.round,
      null,
      { repairKeys: [runtimeCycle.repairKey, structuralCycle.repairKey] },
    ),
  };
  check(
    "repair-multi-finding-requires-complete-handoff",
    validateCodeFixHandoff(
      multiRun,
      normalizeRepairOutbox(multiRun, [buildFixVerification(runtimeCycle)]),
    ).status === "invalid" &&
      validateCodeFixHandoff(
        multiRun,
        normalizeRepairOutbox(multiRun, [
          buildFixVerification(runtimeCycle),
          buildFixVerification(structuralCycle),
        ]),
      ).status === "valid",
    multiRun.activeWorkerDispatch,
  );
  verifyDispatchProtocolChecks(check, {
    run,
    runtimeRun,
    runtimeCycle,
    behaviorDispatchRun,
  });
  check(
    "repair-counters-remain-independent",
    diffFold.loop.noProgressCount === 0 &&
      diffFold.loop.repairCycles[0]?.attempts === 3 &&
      run.acceptance[0].recheckAttempt === undefined,
    diffFold.loop,
  );
}
