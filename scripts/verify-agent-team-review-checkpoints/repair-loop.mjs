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
import { createActiveWorkerDispatch } from "../../backend/src/agent-team/service-workflow-policy.ts";
import {
  buildFixVerification,
  buildRepairEvidence,
  buildRepairRun,
  normalizeRepairOutbox,
} from "./repair-fixtures.mjs";
import { verifyDispatchProtocolChecks } from "./repair-loop-dispatch.mjs";
import { verifyFindingDispositionChecks } from "./repair-loop-finding-disposition.mjs";

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
  const completionSource = readFileSync(
    new URL(
      "../../backend/src/agent-team/service-completion.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const lifecycleSource = readFileSync(
    new URL(
      "../../backend/src/agent-team/service-lifecycle.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const resumeBody = lifecycleSource.slice(
    lifecycleSource.indexOf("async resumeRun"),
    lifecycleSource.indexOf("async decideFinding"),
  );
  const supportSource = readFileSync(
    new URL("../../backend/src/agent-team/service-support.ts", import.meta.url),
    "utf8",
  );
  const pauseDispatchBody = supportSource.slice(
    supportSource.indexOf("protected async pauseForWorkerDispatchError"),
    supportSource.indexOf("private async withVerificationDigests"),
  );
  const repairProtocolSource = readFileSync(
    new URL(
      "../../backend/src/agent-team/service-repair-protocol.ts",
      import.meta.url,
    ),
    "utf8",
  );
  check(
    "repair-bounce-reuses-fixed-worker-thread",
    bounceBody.includes("this.submitWorkerDispatchPrompt(") &&
      bounceBody.includes("bouncePrompt") &&
      bounceBody.indexOf("persistedRun = await this.updateRun") <
        bounceBody.indexOf("this.submitWorkerDispatchPrompt(") &&
      !bounceBody.includes("this.agentLaunch.submitAgentLaunch"),
    bounceBody.slice(0, 4_000),
  );
  check(
    "repair-consumption-persists-receipt-and-advances-protocol",
    completionSource.includes("recordConsumedWorkerDispatch") &&
      completionSource.includes("workerDispatchProtocolVersion: 1") &&
      completionSource.includes("contentSha256: history.contentSha256"),
    completionSource.slice(0, 20_000),
  );
  check(
    "behavior-checkpoint-contract-is-scoped-to-dispatch",
    completionSource.includes(
      "latest.activeWorkerDispatch?.verifiedCheckpointCommit",
    ) &&
      completionSource.includes(
        "latest.activeWorkerDispatch?.checkpointAllowedDirtyPaths",
      ),
    completionSource.slice(0, 20_000),
  );
  check(
    "repair-not-reproduced-review-finding-returns-to-reviewer",
    completionSource.includes(
      'handoff.status === "reviewer_reproduction_required"',
    ) &&
      completionSource.includes(
        "code 无法复现重复 review finding，回派 reviewer 现场举证",
      ),
    completionSource.slice(0, 20_000),
  );
  check(
    "repair-human-resume-creates-fresh-dispatch-before-reactivating-worker",
    resumeBody.includes("activeWorkerRole: null") &&
      resumeBody.includes("workers: setActiveWorker(run.workers, null)") &&
      resumeBody.includes("run.consumedWorkerDispatches?.at(-1)?.role") &&
      resumeBody.includes('lastRepairSourceRole === "behavior_verify"') &&
      resumeBody.includes("repairKey: `behavior_verify:${item.caseId}`") &&
      resumeBody.includes("repairCycles: resumedRepairCycles") &&
      pauseDispatchBody.includes("activeWorkerRole: role") &&
      resumeBody.includes('activeWorkerRole === "code"') &&
      resumeBody.includes("return this.bounceFailuresToCode(") &&
      resumeBody.includes(
        "return this.dispatchSerialWorker(nextRun, activeWorkerRole",
      ) &&
      resumeBody.indexOf("await this.trySendToMain") <
        resumeBody.indexOf("return this.bounceFailuresToCode("),
    resumeBody,
  );
  check(
    "main-agent-intervention-is-explicit-and-cannot-dispose-findings",
    resumeBody.includes("async interveneRun(") &&
      resumeBody.includes(
        'run.status !== "need_human" && !supersedingActiveDispatch',
      ) &&
      resumeBody.includes("if (run.pendingFindingDecision)") &&
      resumeBody.includes("Agent 不得代替人工 disposition") &&
      resumeBody.includes("this.prepareSplitAcceptance(run") &&
      resumeBody.includes("ensureWorkerGateAcceptance(") &&
      resumeBody.includes("return this.bounceFailuresToCode(") &&
      resumeBody.includes("return this.dispatchSerialWorker(") &&
      resumeBody.includes("agentInterventions:") &&
      resumeBody.includes(
        "checkpointAllowedDirtyPaths: input.checkpointAllowedDirtyPaths",
      ) &&
      resumeBody.includes(
        "checkpointExpectedHeadCommit: input.checkpointExpectedHeadCommit",
      ) &&
      resumeBody.includes("Agent intervention 覆盖当前"),
    resumeBody,
  );
  check(
    "repair-protocol-correction-creates-fresh-dispatch-before-prompt",
    repairProtocolSource.indexOf(
      "const correctionDispatch = createActiveWorkerDispatch",
    ) < repairProtocolSource.indexOf("buildPrompt(correctionRun)"),
    repairProtocolSource,
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
    reviewCheckpoint: {
      mode: "local_commit",
      repoRoot: "/tmp/repo",
      originalBranch: "main",
      branch: "runweave/fixture",
      taskBaseCommit: "a".repeat(40),
      lastReviewedCommit: "b".repeat(40),
      pendingReview: null,
      checkpoints: [],
      finalReviewedCommit: null,
    },
    activeWorkerRole: "behavior_verify",
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[2],
      run.updatedAt,
      1,
      run.loop.round,
      null,
      {
        verifiedCheckpointCommit: "c".repeat(40),
        checkpointAllowedDirtyPaths: ["control-plane.ts"],
      },
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
      behaviorRecheckPrompt.includes(
        `本轮被测 checkpoint：${"c".repeat(40)}`,
      ) &&
      behaviorRecheckPrompt.includes(
        `verifiedCheckpointCommit 必须等于 "${"c".repeat(40)}"`,
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
    reviewFindingContractErrors(
      run,
      reviewOutbox,
      reviewOutbox.acceptanceResults,
    ).length === 0,
    reviewOutbox,
  );
  verifyFindingDispositionChecks(check, { run, reviewOutbox });
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
  const repeatedReviewReproduction = buildReviewReproduction({
    status: "reproduced",
    scenarioId: "repeated-review-finding",
  });
  const repeatedReviewOutbox = normalizeAgentTeamWorkerOutbox({
    ...reviewOutbox,
    remainingFindings: [
      {
        ...reviewOutbox.remainingFindings[0],
        reproduction: repeatedReviewReproduction,
      },
    ],
  });
  const repeatedStructuralCycle = {
    ...structuralCycle,
    attempts: 1,
    finding: repeatedReviewOutbox.remainingFindings[0],
  };
  const repeatedStructuralRun = {
    ...structuralRun,
    loop: {
      ...structuralRun.loop,
      repairCycles: [repeatedStructuralCycle],
    },
    activeWorkerDispatch: createActiveWorkerDispatch(
      run.workers[0],
      run.updatedAt,
      1,
      run.loop.round,
      null,
      { repairKeys: [repeatedStructuralCycle.repairKey] },
    ),
  };
  check(
    "repair-repeated-review-finding-rejects-static-contract",
    reviewFindingContractErrors(
      repeatedStructuralRun,
      reviewOutbox,
      reviewOutbox.acceptanceResults,
    ).some((error) => error.includes("修复后重复出现的 P0/P1")),
    reviewOutbox,
  );
  check(
    "repair-repeated-review-finding-requires-executable-reproduction",
    reviewFindingContractErrors(
      repeatedStructuralRun,
      repeatedReviewOutbox,
      repeatedReviewOutbox.acceptanceResults,
    ).length === 0,
    repeatedReviewOutbox,
  );
  const repeatedStructuralPrompt = buildBounceBackPrompt({
    run: repeatedStructuralRun,
    failedCases: [run.acceptance[1]],
    repairCycles: [repeatedStructuralCycle],
  });
  check(
    "repair-repeated-structural-prompt-requires-reviewer-scenario",
    repeatedStructuralPrompt.includes("这是修复后重复出现的 P0/P1") &&
      repeatedStructuralPrompt.includes("backend 会回派 reviewer 现场举证"),
    repeatedStructuralPrompt,
  );
  const reviewerChallengePrompt = buildWorkerRecheckPrompt({
    run: {
      ...repeatedStructuralRun,
      activeWorkerRole: "code_review",
      activeWorkerDispatch: createActiveWorkerDispatch(
        run.workers[1],
        run.updatedAt,
        1,
        run.loop.round,
      ),
    },
    worker: run.workers[1],
    cases: [run.acceptance[1]],
    reviewChallenge: {
      repairKeys: [repeatedStructuralCycle.repairKey],
      reason: "code worker 按 reviewer 场景无法复现",
    },
  });
  check(
    "repair-reviewer-challenge-requires-new-executable-evidence",
    reviewerChallengePrompt.includes("重复 P0/P1 复现争议") &&
      reviewerChallengePrompt.includes("无法复现则从 remainingFindings 移除") &&
      reviewerChallengePrompt.includes("禁止复用上一轮静态证据"),
    reviewerChallengePrompt,
  );
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
