import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createInitialLoop,
  foldRound,
} from "../backend/src/agent-team/loop.ts";
import { normalizeAgentTeamWorkerOutbox } from "../backend/src/agent-team/outbox-resolver.ts";
import { AgentTeamService } from "../backend/src/agent-team/service.ts";
import { recordAgentTeamRunTransition } from "../backend/src/agent-team/activity-events.ts";
import {
  AGENT_TEAM_REVIEW_GATE_CASE_ID,
  behaviorSkipContractErrors,
  behaviorVerificationCasesForDispatch,
  ensureWorkerGateAcceptance,
  expandRecheckCasesForFailures,
} from "../backend/src/agent-team/service-acceptance-policy.ts";
import { createActiveWorkerDispatch } from "../backend/src/agent-team/service-workflow-policy.ts";
import { getAgentTeamControlState } from "../frontend/src/components/terminal/terminal-agent-team-panel-model.ts";
import { withHarness } from "./verify-agent-team-review-checkpoints/bootstrap-lifecycle-harness.mjs";

const checks = [];
const roots = [];

function check(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name}: ${JSON.stringify(detail)}`);
  }
  checks.push(name);
}

function buildRun(harness) {
  const now = new Date().toISOString();
  const reviewWorker = {
    id: "control-plane-review",
    role: "code_review",
    intent: "review the transition fixture",
    panelId: harness.panel.id,
    tmuxPaneId: harness.panel.tmuxPaneId,
    frozen: false,
  };
  const behaviorWorker = {
    id: "control-plane-behavior",
    role: "behavior_verify",
    intent: "verify the transition fixture",
    panelId: harness.panel.id,
    tmuxPaneId: harness.panel.tmuxPaneId,
    frozen: true,
  };
  const acceptance = ensureWorkerGateAcceptance(
    [reviewWorker, behaviorWorker],
    [
      {
        caseId: "ATFR-013",
        sourceCaseId: "ATFR-013",
        sourceFilePath:
          "docs/testing/agent-team/agent-team-control-plane-reliability-optimization.testplan.yaml",
        text: "completion transition remains atomic",
        status: "pending",
        consecutiveFail: 0,
        evidence: [],
      },
    ],
  );
  return {
    run: {
      runId: "atr_control_plane_atomicity",
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      phase: "executing",
      status: "running",
      options: { flow: "code_first", reviewCheckpointMode: "disabled" },
      terminal: { command: "codex", args: [], cwd: harness.session.cwd },
      task: "verify dispatch completion atomicity",
      verification: null,
      reviewCheckpoint: null,
      activeWorkerRole: "code_review",
      activeWorkerDispatch: createActiveWorkerDispatch(
        reviewWorker,
        now,
        null,
        1,
        null,
        { dispatchId: "review-dispatch" },
      ),
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: [],
      clarify: [],
      proposal: null,
      workers: [reviewWorker, behaviorWorker],
      acceptance,
      loop: createInitialLoop(3, 2),
      humanNotes: [],
      logs: [],
      createdAt: now,
      updatedAt: now,
    },
    reviewWorker,
  };
}

async function verifyDispatchCompletionAtomicity(harness) {
  const service = new AgentTeamService({
    terminalSessionManager: harness.manager,
    terminalEventService: { record() {}, subscribe() {} },
    ptyService: harness.options.ptyService,
    runtimeRegistry: harness.options.runtimeRegistry,
    terminalStateService: harness.options.terminalStateService,
    tmuxService: harness.tmuxService,
    cwd: harness.session.cwd,
  });
  const writes = [];
  const prompts = [];
  const writeRun = service.runStore.writeRun.bind(service.runStore);
  service.runStore.writeRun = async (run) => {
    writes.push(structuredClone(run));
    await writeRun(run);
  };
  service.submitWorkerDispatchPrompt = async (
    _run,
    _session,
    _terminal,
    worker,
  ) => {
    prompts.push(worker.role);
  };

  const { run, reviewWorker } = buildRun(harness);
  await service.runStore.writeRun(run);
  writes.length = 0;
  const outboxPath = service.paths.workerOutboxPath(
    run.projectId,
    run.terminalSessionId,
    reviewWorker,
    harness.session.cwd,
  );
  await mkdir(path.dirname(outboxPath), { recursive: true });
  await writeFile(
    outboxPath,
    `${JSON.stringify({
      sessionId: run.terminalSessionId,
      projectId: run.projectId,
      runId: run.runId,
      panelId: reviewWorker.panelId,
      tmuxPaneId: reviewWorker.tmuxPaneId,
      role: "code_review",
      dispatchId: "review-dispatch",
      status: "completed",
      summary: "review passed",
      findings: [],
      resolvedFindings: [],
      remainingFindings: [],
      acceptanceResults: [
        {
          caseId: AGENT_TEAM_REVIEW_GATE_CASE_ID,
          status: "pass",
          summary: "review passed",
          evidence: [],
        },
      ],
      finishedAt: new Date().toISOString(),
    })}\n`,
  );

  const reconciled = await service.reconcileCompletionSignal({
    projectId: run.projectId,
    terminalSessionId: run.terminalSessionId,
    panelId: reviewWorker.panelId,
    tmuxPaneId: reviewWorker.tmuxPaneId,
    cwd: harness.session.cwd,
    source: "app_server",
  });
  const snapshot = writes[0];
  check(
    "completion-fold-receipt-and-next-dispatch-use-one-run-write",
    reconciled &&
      writes.length === 1 &&
      snapshot?.activeWorkerRole === "behavior_verify" &&
      snapshot.activeWorkerDispatch?.role === "behavior_verify" &&
      snapshot.acceptance.find(
        (item) => item.caseId === AGENT_TEAM_REVIEW_GATE_CASE_ID,
      )?.status === "pass" &&
      snapshot.consumedWorkerDispatches?.length === 1 &&
      snapshot.consumedWorkerDispatches[0]?.dispatchId === "review-dispatch" &&
      prompts.join(",") === "behavior_verify",
    { writes, prompts, reconciled },
  );
  check(
    "persisted-snapshots-never-split-active-role-from-dispatch",
    writes.every(
      (item) =>
        (item.activeWorkerRole === null &&
          item.activeWorkerDispatch === null) ||
        (item.activeWorkerRole != null &&
          item.activeWorkerDispatch?.role === item.activeWorkerRole),
    ),
    writes,
  );

  const withoutActiveDispatch = {
    ...snapshot,
    activeWorkerDispatch: null,
  };
  await service.runStore.writeRun(withoutActiveDispatch);
  writes.length = 0;
  prompts.length = 0;
  for (const source of [
    "terminal_event",
    "app_server",
    "startup",
    "watchdog",
  ]) {
    const duplicate = await service.reconcileCompletionSignal({
      projectId: run.projectId,
      terminalSessionId: run.terminalSessionId,
      panelId: reviewWorker.panelId,
      tmuxPaneId: reviewWorker.tmuxPaneId,
      cwd: harness.session.cwd,
      source,
    });
    check(`consumed-dispatch-duplicate-is-idempotent-${source}`, duplicate, {
      source,
      duplicate,
    });
  }
  const afterDuplicates = await service.getRun(run.runId);
  check(
    "consumed-dispatch-is-checked-before-active-dispatch-gate",
    writes.length === 0 &&
      prompts.length === 0 &&
      afterDuplicates?.status === "running" &&
      afterDuplicates.loop.lastReason === null &&
      afterDuplicates.consumedWorkerDispatches?.length === 1,
    { writes, prompts, afterDuplicates },
  );
}

function verifyUiControlStateSemantics(run) {
  const automaticRecovery = getAgentTeamControlState({
    ...run,
    activeWorkerDispatch: {
      ...run.activeWorkerDispatch,
      protocolCorrectionAttempt: 1,
    },
  });
  check(
    "ui-automatic-recovery-has-no-human-actions",
    automaticRecovery.kind === "automatic_recovery" &&
      automaticRecovery.label === "正在自动恢复" &&
      !automaticRecovery.allowsFrameworkRecovery &&
      !automaticRecovery.allowsFindingDecision,
    automaticRecovery,
  );

  const recoveryRequired = getAgentTeamControlState({
    ...run,
    status: "need_human",
    activeWorkerRole: null,
    activeWorkerDispatch: null,
    frameworkRepair: {
      repairId: "repair-fixture",
      reason: "backend restart required",
      begunAt: run.updatedAt,
      backendInstanceIdBefore: "backend-before",
      target: {
        role: "code_review",
        caseIds: ["ATFR-013"],
        panelId: run.workers[0].panelId,
        tmuxPaneId: run.workers[0].tmuxPaneId,
        invalidatedDispatch: run.activeWorkerDispatch,
      },
      result: "blocked",
    },
  });
  check(
    "ui-recovery-required-allows-only-recovery-actions",
    recoveryRequired.kind === "recovery_required" &&
      recoveryRequired.label === "需要恢复现场" &&
      recoveryRequired.allowsFrameworkRecovery &&
      !recoveryRequired.allowsFindingDecision,
    recoveryRequired,
  );

  const scopeDecision = getAgentTeamControlState({
    ...run,
    status: "need_human",
    activeWorkerRole: null,
    activeWorkerDispatch: null,
    pendingFindingDecision: {
      id: "scope-decision-fixture",
      finding: {},
    },
  });
  check(
    "ui-scope-decision-allows-only-finding-actions",
    scopeDecision.kind === "scope_decision" &&
      scopeDecision.label === "需要范围裁决" &&
      !scopeDecision.allowsFrameworkRecovery &&
      scopeDecision.allowsFindingDecision,
    scopeDecision,
  );
}

function verifyStructuredActivityFacts(run) {
  const facts = [];
  const telemetryRun = {
    ...run,
    activeWorkerDispatch: {
      ...run.activeWorkerDispatch,
      protocolCorrectionAttempt: 1,
    },
  };
  recordAgentTeamRunTransition(
    {
      eventFactory: { create: (event) => event },
      recorder: {
        recordBatch: async (events) => {
          facts.push(...events);
          return [];
        },
      },
    },
    null,
    telemetryRun,
  );
  const transitionIds = new Set(facts.map((fact) => fact.payload.transitionId));
  check(
    "activity-facts-carry-structured-transition-fields",
    facts.length >= 2 &&
      facts.every(
        (fact) =>
          typeof fact.payload.transitionId === "string" &&
          typeof fact.payload.reasonCode === "string" &&
          typeof fact.payload.purpose === "string",
      ),
    facts,
  );
  check(
    "activity-facts-from-one-run-write-share-transition-id",
    transitionIds.size === 1,
    Array.from(transitionIds),
  );
  const dispatchFact = facts.find(
    (fact) => fact.eventName === "agent_team.worker.dispatched",
  );
  check(
    "activity-facts-express-dispatch-purpose-without-run-events",
    dispatchFact?.payload.purpose === "protocol_correction" &&
      dispatchFact.payload.reasonCode === "protocol_correction_requested" &&
      !("events" in telemetryRun),
    { dispatchFact, runKeys: Object.keys(telemetryRun) },
  );
}

function verifyStructuredSkipAndMinimalRerun(run) {
  const acceptanceCase = {
    caseId: "SKIP-BLOCKED",
    text: "wait for ROOT",
    status: "pending",
    lastRunStatus: "pending",
    consecutiveFail: 0,
    evidence: [],
  };
  const folded = foldRound(
    { ...run, acceptance: [acceptanceCase] },
    {
      acceptanceResults: [
        {
          caseId: acceptanceCase.caseId,
          status: "skipped",
          skip: {
            code: "blocked_by_case",
            blockerCaseIds: ["ROOT"],
            retryable: true,
            detail: "ROOT 尚未通过",
          },
          evidence: [],
        },
      ],
    },
  );
  check(
    "structured-skip-is-folded-and-projected-to-legacy-display",
    folded.acceptance[0]?.skip?.code === "blocked_by_case" &&
      folded.acceptance[0]?.skip?.blockerCaseIds?.join(",") === "ROOT" &&
      folded.acceptance[0]?.skipReason === "ROOT 尚未通过",
    folded.acceptance[0],
  );

  const normalized = normalizeAgentTeamWorkerOutbox({
    sessionId: run.terminalSessionId,
    role: "behavior_verify",
    status: "completed",
    summary: "structured skip",
    error: null,
    finishedAt: run.updatedAt,
    acceptanceResults: [
      {
        caseId: "SKIP-BLOCKED",
        status: "skipped",
        skip: {
          code: "blocked_by_case",
          blockerCaseIds: [" ROOT ", "ROOT"],
          retryable: true,
          detail: " wait root ",
        },
        evidence: [],
      },
    ],
  });
  check(
    "structured-skip-is-normalized-at-outbox-boundary",
    normalized.acceptanceResults?.[0]?.skip?.blockerCaseIds?.join(",") ===
      "ROOT" && normalized.acceptanceResults?.[0]?.skip?.detail === "wait root",
    normalized.acceptanceResults,
  );

  const makeCase = (caseId, status, extra = {}) => ({
    caseId,
    text: caseId,
    status,
    lastRunStatus: status,
    consecutiveFail: 0,
    evidence: [],
    ...extra,
  });
  const behaviorCases = [
    makeCase("DOWNSTREAM", "pass", { dependsOn: ["BLOCKED"] }),
    makeCase("BLOCKED", "pending", {
      lastRunStatus: "skipped",
      skip: {
        code: "blocked_by_case",
        blockerCaseIds: ["ROOT"],
        retryable: true,
        detail: "wait root",
      },
    }),
    makeCase("ROOT", "fail"),
    makeCase("ENV", "pending", {
      lastRunStatus: "skipped",
      skip: {
        code: "environment",
        retryable: true,
        detail: "restore environment first",
      },
    }),
    makeCase("NA", "pending", {
      lastRunStatus: "skipped",
      skip: {
        code: "not_applicable",
        retryable: false,
        detail: "scope does not apply",
      },
    }),
    makeCase("OTHER", "pass"),
  ];
  const behaviorRun = {
    ...run,
    workers: [
      {
        id: "structured-skip-verifier",
        role: "behavior_verify",
        intent: "verify structured skips",
      },
    ],
    acceptance: behaviorCases,
  };
  check(
    "blocked-case-does-not-rerun-before-dependency-passes",
    behaviorVerificationCasesForDispatch(behaviorRun)
      .map((item) => item.caseId)
      .join(",") === "ROOT",
    behaviorVerificationCasesForDispatch(behaviorRun).map(
      (item) => item.caseId,
    ),
  );
  const dependencyResolvedRun = {
    ...behaviorRun,
    acceptance: behaviorCases.map((item) =>
      item.caseId === "ROOT"
        ? { ...item, status: "pass", lastRunStatus: "pass" }
        : item,
    ),
  };
  check(
    "dependency-resolution-reruns-only-minimal-case-closure",
    behaviorVerificationCasesForDispatch(dependencyResolvedRun)
      .map((item) => item.caseId)
      .join(",") === "DOWNSTREAM,BLOCKED",
    behaviorVerificationCasesForDispatch(dependencyResolvedRun).map(
      (item) => item.caseId,
    ),
  );

  const transitiveCases = [
    makeCase("C", "pass", { dependsOn: ["B"] }),
    makeCase("B", "pass", { dependsOn: ["A"] }),
    makeCase("A", "fail"),
  ];
  const transitiveRun = { ...behaviorRun, acceptance: transitiveCases };
  check(
    "dependency-closure-is-transitive-and-order-independent",
    expandRecheckCasesForFailures(transitiveRun, [transitiveCases[2]])
      .map((item) => item.caseId)
      .join(",") === "C,B,A",
    expandRecheckCasesForFailures(transitiveRun, [transitiveCases[2]]).map(
      (item) => item.caseId,
    ),
  );

  const contractErrors = behaviorSkipContractErrors(behaviorRun, [
    {
      caseId: "BLOCKED",
      status: "skipped",
      skip: {
        code: "fail_fast",
        retryable: true,
        detail: "stopped after root failure",
      },
      evidence: [],
    },
    {
      caseId: "NA",
      status: "skipped",
      skip: {
        code: "not_applicable",
        retryable: true,
        detail: "scope does not apply",
      },
      evidence: [],
    },
  ]);
  check(
    "invalid-structured-skips-trigger-protocol-errors",
    contractErrors.some((error) => error.includes("缺少 blockerCaseIds")) &&
      contractErrors.some((error) => error.includes("retryable 必须为 false")),
    contractErrors,
  );
}

try {
  await withHarness(roots, async (harness) => {
    await verifyDispatchCompletionAtomicity(harness);
    const run = buildRun(harness).run;
    verifyUiControlStateSemantics(run);
    verifyStructuredActivityFacts(run);
    verifyStructuredSkipAndMinimalRerun(run);
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        checkCount: checks.length,
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
}
