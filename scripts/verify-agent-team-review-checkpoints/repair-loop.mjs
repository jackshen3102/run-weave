import { readFileSync } from "node:fs";
import { foldRound } from "../../backend/src/agent-team/loop.ts";
import { normalizeAgentTeamWorkerOutbox } from "../../backend/src/agent-team/outbox-resolver.ts";
import {
  buildBounceBackPrompt,
  buildWorkerStartupPrompt,
  buildWorkerRecheckPrompt,
} from "../../backend/src/agent-team/prompt-builders.ts";
import {
  foldRepairGateResult,
  incrementRepairAttempts,
  resolveMaxRepairAttempts,
  resolveRepairTargets,
  reviewFindingContractErrors,
  validateCodeFixHandoff,
} from "../../backend/src/agent-team/repair-loop.ts";
import {
  completionOutboxIdentityMismatch,
  completionSignalWorkerMismatch,
  createActiveWorkerDispatch,
  resolveActiveWorkerDispatch,
  workerOutboxFreshnessMismatch,
} from "../../backend/src/agent-team/service-workflow-policy.ts";
import {
  buildFixVerification,
  buildRepairEvidence,
  buildRepairRun,
  normalizeRepairOutbox,
} from "./repair-fixtures.mjs";

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

export function verifyEvidenceGatedRepairLoop(check) {
  const executionSource = readFileSync(
    new URL(
      "../../backend/src/agent-team/service-execution.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const bounceBody = executionSource.slice(
    executionSource.indexOf("protected async bounceFailuresToCode"),
  );
  check(
    "repair-bounce-launches-formal-prompt-as-initial-query",
    bounceBody.includes("this.agentReadiness.ensureAgentReady") &&
      bounceBody.includes("prompt: bouncePrompt") &&
      !bounceBody.includes("this.promptSender.sendPromptToPane"),
    bounceBody.slice(0, 4_000),
  );
  const run = buildRepairRun();
  const behaviorOutbox = normalizeAgentTeamWorkerOutbox({
    sessionId: run.terminalSessionId,
    panelId: "behavior-panel",
    role: "behavior_verify",
    status: "completed",
    summary: "runtime failed",
    error: null,
    finishedAt: "2026-07-14T00:00:10.000Z",
    acceptanceResults: [
      {
        caseId: "CASE-RUNTIME-001",
        status: "fail",
        summary: "runtime still fails",
        evidence: [buildRepairEvidence("runtime-fail")],
      },
    ],
  });
  const behaviorTargets = resolveRepairTargets(
    run,
    behaviorOutbox,
    behaviorOutbox.acceptanceResults,
  );
  const behaviorFold = foldRepairGateResult({
    loop: run.loop,
    completedRole: "behavior_verify",
    acceptanceResults: behaviorOutbox.acceptanceResults,
    targets: behaviorTargets,
    round: 1,
  });
  const runtimeCycle = behaviorFold.loop.repairCycles[0];
  const runtimeRun = {
    ...run,
    loop: behaviorFold.loop,
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[0],
      run.updatedAt,
      1,
      run.loop.round,
      null,
      { repairKeys: [runtimeCycle.repairKey] },
    ),
  };
  const runtimePrompt = buildBounceBackPrompt({
    run: runtimeRun,
    failedCases: [run.acceptance[0]],
    repairCycles: [runtimeCycle],
  });
  check(
    "repair-runtime-prompt-requires-real-reproduction",
      runtimePrompt.includes("$toolkit:reproduce-before-fix") &&
      runtimePrompt.includes("同一 scenarioId") &&
      runtimePrompt.includes("任一必跑项失败立即停止") &&
      runtimePrompt.includes(
        `DispatchId: ${runtimeRun.activeWorkerDispatch.dispatchId}`,
      ),
    runtimePrompt,
  );
  const startupPrompt = buildWorkerStartupPrompt({
    run: runtimeRun,
    worker: run.workers[0],
    acceptance: run.acceptance,
    outboxPath: ".runweave/outbox/repair.json",
  });
  check(
    "repair-startup-prompt-binds-outbox-to-dispatch",
    startupPrompt.includes(
      `outbox 顶层 dispatchId 必须等于 "${runtimeRun.activeWorkerDispatch.dispatchId}"`,
    ),
    startupPrompt,
  );
  const reviewDispatchRun = {
    ...runtimeRun,
    activeWorkerRole: "code_review",
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[1],
      run.updatedAt,
      1,
      run.loop.round,
    ),
  };
  const reviewRecheckPrompt = buildWorkerRecheckPrompt({
    run: reviewDispatchRun,
    worker: run.workers[1],
    cases: [run.acceptance[1]],
    triggerSummary: "code handoff",
  });
  check(
    "repair-review-recheck-does-not-claim-fix-completion",
    reviewRecheckPrompt.includes("Code Agent 已提交本轮代码结果，请独立审查") &&
      !reviewRecheckPrompt.includes("已完成修复"),
    reviewRecheckPrompt,
  );
  const behaviorDispatchRun = {
    ...runtimeRun,
    activeWorkerRole: "behavior_verify",
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[2],
      run.updatedAt,
      1,
      run.loop.round,
    ),
  };
  const behaviorRecheckPrompt = buildWorkerRecheckPrompt({
    run: behaviorDispatchRun,
    worker: run.workers[2],
    cases: [run.acceptance[0]],
    triggerSummary: "incremental review passed",
  });
  check(
    "repair-behavior-recheck-distinguishes-review-from-behavior-pass",
    behaviorRecheckPrompt.includes("以下行为 case 尚未验证或需要复验") &&
      behaviorRecheckPrompt.includes("review pass 不代表 behavior pass") &&
      behaviorRecheckPrompt.includes("上游 review 摘要") &&
      behaviorRecheckPrompt.includes(
        `DispatchId: ${behaviorDispatchRun.activeWorkerDispatch.dispatchId}`,
      ) &&
      !behaviorRecheckPrompt.includes("本轮修复摘要") &&
      !behaviorRecheckPrompt.includes("已完成修复"),
    behaviorRecheckPrompt,
  );
  const validRuntimeOutbox = normalizeRepairOutbox(runtimeRun, [
    buildFixVerification(runtimeCycle),
  ]);
  check(
    "repair-runtime-before-after-handoff-valid",
    validateCodeFixHandoff(runtimeRun, validRuntimeOutbox).status === "valid",
    validRuntimeOutbox,
  );
  check(
    "repair-missing-handoff-rejected",
    validateCodeFixHandoff(runtimeRun, normalizeRepairOutbox(runtimeRun, []))
      .status === "invalid",
    "missing fixVerifications accepted",
  );
  const blockedOutbox = normalizeRepairOutbox(runtimeRun, [
    buildFixVerification(runtimeCycle, {
      reproduction: {
        mode: "real_product",
        status: "blocked",
        scenarioId: "repair-runtime",
        validationSessionId: "dvs-repair",
        evidence: [buildRepairEvidence("blocked")],
      },
    }),
  ]);
  check(
    "repair-blocked-handoff-stops",
    validateCodeFixHandoff(runtimeRun, blockedOutbox).status === "blocked",
    blockedOutbox,
  );
  const failedImpactOutbox = normalizeRepairOutbox(runtimeRun, [
    buildFixVerification(runtimeCycle, {
      impactedChecks: [
        {
          label: "temporal failure",
          dimension: "temporal",
          status: "fail",
          summary: "stop immediately",
          evidence: [buildRepairEvidence("temporal-fail")],
        },
      ],
    }),
  ]);
  check(
    "repair-failed-impacted-check-blocks",
    validateCodeFixHandoff(runtimeRun, failedImpactOutbox).status === "blocked",
    failedImpactOutbox,
  );

  const reviewOutbox = normalizeAgentTeamWorkerOutbox({
    sessionId: run.terminalSessionId,
    panelId: "review-panel",
    role: "code_review",
    status: "completed",
    summary: "P1",
    error: null,
    finishedAt: "2026-07-14T00:00:20.000Z",
    remainingFindings: [
      {
        severity: "P1",
        status: "open",
        title: "checkpoint ownership",
        summary: "backend owns checkpoint index",
        invariantKey: "checkpoint.index-ownership",
        verificationMode: "structural",
        ref: "review:checkpoint",
        reproduction: buildReviewReproduction(),
      },
    ],
    acceptanceResults: [
      {
        caseId: "case_2",
        status: "fail",
        summary: "P1",
        evidence: [buildRepairEvidence("review-fail")],
      },
    ],
  });
  check(
    "repair-review-finding-contract-valid",
    reviewFindingContractErrors(reviewOutbox, reviewOutbox.acceptanceResults)
      .length === 0,
    reviewOutbox,
  );
  const reviewTargets = resolveRepairTargets(
    run,
    reviewOutbox,
    reviewOutbox.acceptanceResults,
  );
  const reviewFold = foldRepairGateResult({
    loop: behaviorFold.loop,
    completedRole: "code_review",
    acceptanceResults: reviewOutbox.acceptanceResults,
    targets: reviewTargets,
    round: 2,
  });
  const structuralCycle = reviewFold.loop.repairCycles.find(
    (cycle) => cycle.sourceRole === "code_review",
  );
  const structuralRun = {
    ...run,
    loop: reviewFold.loop,
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[0],
      run.updatedAt,
      1,
      run.loop.round,
      null,
      { repairKeys: [structuralCycle.repairKey] },
    ),
  };
  const structuralPrompt = buildBounceBackPrompt({
    run: structuralRun,
    failedCases: [run.acceptance[1]],
    repairCycles: [structuralCycle],
  });
  check(
    "repair-structural-uses-original-harness",
    structuralPrompt.includes("原样复跑 reviewer evidence") &&
      !structuralPrompt.includes("Codex worker 在修改源码前显式调用"),
    structuralPrompt,
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
  const currentBehaviorOutbox = normalizeAgentTeamWorkerOutbox({
    sessionId: behaviorDispatchRun.terminalSessionId,
    panelId: run.workers[2].panelId,
    tmuxPaneId: run.workers[2].tmuxPaneId,
    projectId: behaviorDispatchRun.projectId,
    runId: behaviorDispatchRun.runId,
    role: "behavior_verify",
    dispatchId: behaviorDispatchRun.activeWorkerDispatch.dispatchId,
    status: "completed",
    summary: "current behavior result",
    error: null,
    finishedAt: "2026-07-14T00:01:00.000Z",
  });
  const delayedStaleOutbox = normalizeAgentTeamWorkerOutbox({
    ...currentBehaviorOutbox,
    dispatchId: "dispatch-from-previous-round",
  });
  check(
    "repair-current-dispatch-outbox-accepted",
    completionOutboxIdentityMismatch(
      behaviorDispatchRun,
      run.workers[2],
      behaviorDispatchRun.activeWorkerDispatch,
      currentBehaviorOutbox,
      true,
    ) === null,
    currentBehaviorOutbox,
  );
  check(
    "repair-delayed-stale-outbox-rejected-even-when-fresh",
    workerOutboxFreshnessMismatch(
      behaviorDispatchRun.activeWorkerDispatch,
      2,
    ) === null &&
      completionOutboxIdentityMismatch(
        behaviorDispatchRun,
        run.workers[2],
        behaviorDispatchRun.activeWorkerDispatch,
        delayedStaleOutbox,
        true,
      ) === "outbox_dispatch_id_mismatch",
    delayedStaleOutbox,
  );
  const missingDispatchOutbox = normalizeAgentTeamWorkerOutbox({
    ...currentBehaviorOutbox,
    dispatchId: null,
  });
  check(
    "repair-new-dispatch-requires-outbox-dispatch-id",
    completionOutboxIdentityMismatch(
      behaviorDispatchRun,
      run.workers[2],
      behaviorDispatchRun.activeWorkerDispatch,
      missingDispatchOutbox,
      true,
    ) === "outbox_dispatch_id_missing",
    missingDispatchOutbox,
  );
  const legacyDispatch = {
    ...behaviorDispatchRun.activeWorkerDispatch,
    outboxDispatchIdRequired: undefined,
  };
  check(
    "repair-legacy-dispatch-allows-legacy-outbox",
    completionOutboxIdentityMismatch(
      { ...behaviorDispatchRun, activeWorkerDispatch: legacyDispatch },
      run.workers[2],
      legacyDispatch,
      missingDispatchOutbox,
      true,
    ) === null,
    legacyDispatch,
  );
  const recoveredDispatchId =
    behaviorDispatchRun.activeWorkerDispatch.dispatchId;
  const recoveredRun = {
    ...behaviorDispatchRun,
    activeWorkerDispatch: null,
    acceptance: [
      {
        ...run.acceptance[0],
        status: "pending",
        recheckRequestedAt: run.updatedAt,
        recheckDispatchId: recoveredDispatchId,
        recheckWorkerPanelId: run.workers[2].panelId,
        recheckWorkerRole: "behavior_verify",
        recheckOutboxMtimeMs: 1,
      },
    ],
  };
  const recoveredDispatch = resolveActiveWorkerDispatch(
    recoveredRun,
    run.workers[2],
  );
  check(
    "repair-recovered-dispatch-preserves-persisted-id",
    recoveredDispatch.dispatchId === recoveredDispatchId &&
      recoveredDispatch.outboxDispatchIdRequired === false,
    recoveredDispatch,
  );
  check(
    "repair-stale-outbox-cannot-double-count",
    workerOutboxFreshnessMismatch(
      createActiveWorkerDispatch(
        run.workers[0],
        run.updatedAt,
        200,
        run.loop.round,
      ),
      200,
    ) === "outbox_not_newer_than_dispatch_baseline",
    "stale outbox accepted",
  );
  check(
    "repair-accepted-handoff-restart-state-is-idempotent",
    incrementRepairAttempts(runtimeRun.loop, [runtimeCycle.repairKey])
      .repairCycles[0]?.attempts === 1 &&
      completionSignalWorkerMismatch(
        {
          kind: "completion",
          payload: { panelId: "code-panel", tmuxPaneId: "%1" },
        },
        run.workers[1],
      ) === "signal_panel_mismatch",
    "a repeated code completion could match the persisted reviewer dispatch",
  );
  check(
    "repair-legacy-outbox-remains-readable",
    Boolean(
      normalizeAgentTeamWorkerOutbox({
        sessionId: "legacy",
        role: "code",
        status: "completed",
        summary: "legacy",
        error: null,
        finishedAt: "2026-07-14T00:00:00.000Z",
      }),
    ),
    "legacy outbox rejected",
  );
  check(
    "repair-counters-remain-independent",
    diffFold.loop.noProgressCount === 0 &&
      diffFold.loop.repairCycles[0]?.attempts === 3 &&
      run.acceptance[0].recheckAttempt === undefined,
    diffFold.loop,
  );
}
