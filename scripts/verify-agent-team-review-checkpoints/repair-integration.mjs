import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { captureRepairSourceFingerprint } from "../../backend/src/agent-team/repair-source-fingerprint.ts";
import { buildHumanGateMainPrompt } from "../../backend/src/agent-team/prompt-builders.ts";
import {
  assertAcceptanceRefreshPreservesTraceableCases,
  mergeAcceptanceRefresh,
  resetPersistedAcceptanceForRefresh,
} from "../../backend/src/agent-team/service-acceptance-policy.ts";
import {
  isAgentTeamProjectFileMissingError,
  resolveAgentTeamProjectFile,
} from "../../backend/src/agent-team/acceptance-case-loader.ts";
import { AgentTeamServiceSupport } from "../../backend/src/agent-team/service-support.ts";
import { createAgentTeamRouter } from "../../backend/src/routes/agent-team.ts";
import { buildRepairRun } from "./repair-fixtures.mjs";

const backendRequire = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const express = backendRequire("express");
let recordCheck = null;
let createRepoFixture = null;

function check(...args) {
  return recordCheck(...args);
}

function createRepo() {
  return createRepoFixture();
}

function acceptanceCase(caseId) {
  return {
    caseId,
    sourceCaseId: caseId,
    sourceFilePath: "docs/testing/full.testplan.yaml",
    text: caseId,
    status: "pending",
    consecutiveFail: 0,
    evidence: [],
  };
}

function verifyAcceptanceRefreshPreservesCases() {
  const existing = [acceptanceCase("BSP-001"), acceptanceCase("BSP-002")];
  let removalError = null;
  try {
    assertAcceptanceRefreshPreservesTraceableCases(existing, [
      acceptanceCase("BSP-002"),
      acceptanceCase("BSP-003"),
    ]);
  } catch (error) {
    removalError = error;
  }
  assertAcceptanceRefreshPreservesTraceableCases(existing, [
    ...existing,
    acceptanceCase("BSP-003"),
  ]);
  check(
    "agent-intervention-refresh-cannot-silently-drop-traceable-cases",
    removalError?.statusCode === 409 &&
      removalError.message.includes("BSP-001") &&
      removalError.message.includes("完整测试案例文件"),
    { removalError: removalError?.message },
  );

  const passedCase = {
    ...acceptanceCase("BSP-001"),
    status: "pass",
    resultSummary: "existing pass",
    evidence: [
      {
        type: "command",
        label: "existing evidence",
        summary: "passed before refresh",
        ref: "fixture:existing-pass",
      },
    ],
  };
  const failedCase = {
    ...acceptanceCase("BSP-002"),
    status: "fail",
    resultSummary: "old contract failed",
  };
  const refreshedPassedCase = {
    ...acceptanceCase("BSP-001"),
    sourceFilePath: "docs/testing/refreshed.testplan.yaml",
  };
  const refreshedAffectedCase = {
    ...acceptanceCase("BSP-002"),
    text: "BSP-002 refreshed contract",
    sourceFilePath: "docs/testing/refreshed.testplan.yaml",
  };
  const merged = mergeAcceptanceRefresh(
    [passedCase, failedCase],
    [refreshedPassedCase, refreshedAffectedCase],
    ["BSP-002"],
  );
  check(
    "agent-intervention-refresh-preserves-unaffected-case-results",
    merged[0]?.caseId === "BSP-001" &&
      merged[0]?.status === "pass" &&
      merged[0]?.resultSummary === "existing pass" &&
      merged[0]?.evidence[0]?.ref === "fixture:existing-pass" &&
      merged[0]?.sourceFilePath === "docs/testing/refreshed.testplan.yaml" &&
      merged[1]?.caseId === "BSP-002" &&
      merged[1]?.status === "pending" &&
      merged[1]?.evidence.length === 0,
    merged,
  );

  let undeclaredChangeError = null;
  try {
    mergeAcceptanceRefresh(
      [passedCase, failedCase],
      [
        { ...refreshedPassedCase, text: "BSP-001 undeclared change" },
        refreshedAffectedCase,
      ],
      ["BSP-002"],
    );
  } catch (error) {
    undeclaredChangeError = error;
  }
  check(
    "agent-intervention-refresh-rejects-undeclared-contract-change",
    undeclaredChangeError?.statusCode === 409 &&
      undeclaredChangeError.message.includes("BSP-001"),
    { undeclaredChangeError: undeclaredChangeError?.message },
  );

  const reset = resetPersistedAcceptanceForRefresh([
    {
      ...failedCase,
      sourceHeading: "BSP-002 persisted contract",
      tags: ["required"],
      dependsOn: ["BSP-001"],
      consecutiveFail: 2,
      evidence: [
        {
          type: "command",
          label: "stale evidence",
          summary: "must be cleared before rerun",
          ref: "fixture:stale",
        },
      ],
      recheckAttempt: 1,
      lastRunStatus: "fail",
      skipReason: "stale skip reason",
    },
  ]);
  check(
    "agent-intervention-persisted-contract-resets-execution-state",
    reset[0]?.caseId === "BSP-002" &&
      reset[0]?.sourceHeading === "BSP-002 persisted contract" &&
      reset[0]?.dependsOn?.[0] === "BSP-001" &&
      reset[0]?.status === "pending" &&
      reset[0]?.consecutiveFail === 0 &&
      reset[0]?.evidence.length === 0 &&
      reset[0]?.recheckAttempt === 0 &&
      reset[0]?.lastRunStatus === "pending" &&
      reset[0]?.skipReason === null,
    reset,
  );
}

async function verifyMissingAcceptanceSourceClassification() {
  const root = await createRepo();
  const requestedPath = "docs/testing/removed.testplan.yaml";
  let missingError = null;
  try {
    await resolveAgentTeamProjectFile(root, requestedPath, "测试案例文件");
  } catch (error) {
    missingError = error;
  }
  check(
    "agent-intervention-classifies-removed-acceptance-source",
    isAgentTeamProjectFileMissingError(missingError, requestedPath) &&
      !isAgentTeamProjectFileMissingError(
        missingError,
        "docs/testing/another.testplan.yaml",
      ),
    { missingError: missingError?.message, details: missingError?.details },
  );
}

async function verifyPersistedAcceptanceRefreshFallback() {
  const root = await createRepo();
  const sourceFilePath = "docs/testing/removed.testplan.yaml";
  const service = Object.create(AgentTeamServiceSupport.prototype);
  service.terminalSessionManager = {
    getSession: (sessionId) =>
      sessionId === "terminal" ? { id: sessionId, cwd: root } : null,
    getProject: (projectId) =>
      projectId === "project" ? { id: projectId, path: root } : null,
  };
  const run = {
    terminalSessionId: "terminal",
    projectId: "project",
    verification: {
      planFilePath: null,
      planSha256: null,
      testCaseFilePath: null,
      testCaseSha256: null,
      generatedTestCaseFilePath: sourceFilePath,
      generatedTestCaseSha256: "persisted-source-sha",
      acceptanceSource: "task_generated",
    },
    acceptance: [
      {
        ...acceptanceCase("BSP-002"),
        sourceFilePath,
        status: "fail",
        consecutiveFail: 2,
        resultSummary: "old failure",
        evidence: [
          {
            type: "command",
            label: "old evidence",
            summary: "must be reset",
            ref: "fixture:old-evidence",
          },
        ],
      },
    ],
  };
  const recovered = await service.prepareAcceptanceRefresh(
    run,
    sourceFilePath,
    true,
  );
  await service.assertVerificationSourcesUnchanged(run);
  let planDriftError = null;
  try {
    await service.assertVerificationSourcesUnchanged({
      ...run,
      verification: {
        ...run.verification,
        planFilePath: "app.txt",
        planSha256: "stale-plan-sha",
      },
    });
  } catch (error) {
    planDriftError = error;
  }
  let explicitReplacementError = null;
  try {
    await service.prepareAcceptanceRefresh(run, sourceFilePath, false);
  } catch (error) {
    explicitReplacementError = error;
  }
  check(
    "agent-intervention-recovers-deleted-yaml-from-persisted-contract",
    recovered.usedPersistedAcceptance === true &&
      recovered.verification === run.verification &&
      recovered.acceptance[0]?.caseId === "BSP-002" &&
      recovered.acceptance[0]?.status === "pending" &&
      recovered.acceptance[0]?.evidence.length === 0 &&
      recovered.startLog.includes("run 内持久化验收合同") &&
      planDriftError?.statusCode === 409 &&
      planDriftError.message.includes("计划文件已变化") &&
      isAgentTeamProjectFileMissingError(
        explicitReplacementError,
        sourceFilePath,
      ),
    {
      recovered,
      planDriftError: planDriftError?.message,
      explicitReplacementError: explicitReplacementError?.message,
    },
  );
}

function verifyBlockedBehaviorMainPrompt() {
  const blockedCase = {
    ...acceptanceCase("BSP-017"),
    status: "pending",
    lastRunStatus: "skipped",
    sourceHeading: "### BSP-017 warm retry",
    text: "前置条件：pool-01 warm runtime 存在",
    skipReason: "Given 不成立：warm runtime 缺失",
    evidence: [
      {
        type: "command",
        label: "Given probe",
        summary: "warm runtime not found",
        ref: "fixture:given-probe",
      },
    ],
  };
  const prompt = buildHumanGateMainPrompt({
    ...buildRepairRun(),
    runId: "atr_refresh_fixture",
    terminalSessionId: "terminal",
    projectId: "project",
    status: "need_human",
    loop: {
      ...buildRepairRun().loop,
      lastReason: "behavior_verify 环境阻塞，必跑用例未完成：BSP-017",
    },
    acceptance: [blockedCase],
  });
  check(
    "behavior-blocked-main-prompt-preserves-analysis-context-and-scope",
    prompt.includes("BSP-017") &&
      prompt.includes("Given 不成立：warm runtime 缺失") &&
      prompt.includes("fixture:given-probe") &&
      prompt.includes("不要默认修改测试合同") &&
      prompt.includes("rw agent-team intervene atr_refresh_fixture") &&
      prompt.includes("禁止全量重跑"),
    prompt,
  );
  const proposalPrompt = buildHumanGateMainPrompt({
    ...buildRepairRun(),
    runId: "atr_proposal_fixture",
    phase: "proposal",
    status: "need_human",
    logs: ["main agent 产出拆分提案（待人工确认）"],
  });
  check(
    "human-gate-main-prompt-does-not-bypass-human-authority",
    proposalPrompt.includes("Human Gate") &&
      proposalPrompt.includes("等待确认或拒绝") &&
      proposalPrompt.includes("不得代替用户审批") &&
      proposalPrompt.includes("不授权绕过 Human Gate"),
    proposalPrompt,
  );
  const recoveryPrompt = buildHumanGateMainPrompt({
    ...buildRepairRun(),
    runId: "atr_recovery_fixture",
    phase: "executing",
    status: "need_human",
    loop: {
      ...buildRepairRun().loop,
      lastReason: "协议补交期间源码、Git HEAD 或 index 已变化",
    },
  });
  check(
    "execution-recovery-gate-delegates-safe-recovery-to-main-agent",
    recoveryPrompt.includes("Agent Recovery Gate") &&
      recoveryPrompt.includes("自动推进允许的下一步") &&
      recoveryPrompt.includes("--action dispatch") &&
      recoveryPrompt.includes("<code|code_review|behavior_verify>") &&
      recoveryPrompt.includes("--action refresh_acceptance") &&
      recoveryPrompt.includes("framework-repair status") &&
      recoveryPrompt.includes("不得仅因状态名为 need_human 就向用户请求确认"),
    recoveryPrompt,
  );
}

async function verifyRepairSourceFingerprint() {
  const root = await createRepo();
  const baseline = await captureRepairSourceFingerprint(root);

  await mkdir(path.join(root, ".runweave"), { recursive: true });
  await writeFile(path.join(root, ".runweave", "protocol.json"), "runtime\n");
  const runtimeOnly = await captureRepairSourceFingerprint(root);
  check(
    "repair-protocol-runtime-artifacts-do-not-change-source-fingerprint",
    runtimeOnly.sha256 === baseline.sha256,
    { baseline, runtimeOnly },
  );

  await writeFile(path.join(root, "app.txt"), "changed\n");
  const trackedChange = await captureRepairSourceFingerprint(root);
  check(
    "repair-protocol-tracked-source-change-updates-fingerprint",
    trackedChange.sha256 !== baseline.sha256,
    { baseline, trackedChange },
  );

  await writeFile(path.join(root, "new-source.txt"), "untracked\n");
  const untrackedChange = await captureRepairSourceFingerprint(root);
  check(
    "repair-protocol-untracked-source-change-updates-fingerprint",
    untrackedChange.sha256 !== trackedChange.sha256,
    { trackedChange, untrackedChange },
  );
}

async function verifyRepairBudgetRoute() {
  const acceptedOptions = [];
  const service = {
    async startRun(input) {
      acceptedOptions.push(input.options ?? {});
      return { ok: true, options: input.options ?? {} };
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/agent-team", createAgentTeamRouter(service));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/agent-team/runs`;
    const post = (options) =>
      fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project",
          terminalSessionId: "terminal",
          task: "fixture",
          options,
        }),
      });
    const invalidLow = await post({ maxRepairAttempts: 0 });
    const invalidHigh = await post({ maxRepairAttempts: 6 });
    const invalidNotification = await post({
      notifyMainOnHumanGate: "false",
    });
    const validLow = await post({ maxRepairAttempts: 1 });
    const validHigh = await post({ maxRepairAttempts: 5 });
    const validDefault = await post({});
    const notificationDisabled = await post({ notifyMainOnHumanGate: false });
    const notificationEnabled = await post({ notifyMainOnHumanGate: true });
    check(
      "repair-budget-route-enforces-one-to-five",
      invalidLow.status === 400 &&
        invalidHigh.status === 400 &&
        invalidNotification.status === 400 &&
        validLow.ok &&
        validHigh.ok &&
        validDefault.ok &&
        notificationDisabled.ok &&
        notificationEnabled.ok &&
        acceptedOptions.length === 5 &&
        acceptedOptions[0]?.maxRepairAttempts === 1 &&
        acceptedOptions[1]?.maxRepairAttempts === 5 &&
        acceptedOptions[2]?.maxRepairAttempts === undefined &&
        acceptedOptions[3]?.notifyMainOnHumanGate === false &&
        acceptedOptions[4]?.notifyMainOnHumanGate === true,
      {
        statuses: [
          invalidLow.status,
          invalidHigh.status,
          invalidNotification.status,
          validLow.status,
          validHigh.status,
          validDefault.status,
          notificationDisabled.status,
          notificationEnabled.status,
        ],
        acceptedOptions,
      },
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function verifyAgentInterventionRoute() {
  const acceptedInterventions = [];
  const service = {
    async interveneRun(runId, input) {
      acceptedInterventions.push({ runId, input });
      return {
        runId,
        status: "running",
        activeWorkerRole: input.role,
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/agent-team", createAgentTeamRouter(service));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/agent-team/runs/run-1/intervene`;
    const post = (body) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const dispatch = await post({
      action: "dispatch",
      role: "code_review",
      note: "复用原 reviewer pane 重新举证",
      caseIds: ["BSP-017"],
      checkpointExpectedHeadCommit: "0123456789abcdef0123456789abcdef01234567",
      checkpointRebasedCommit: "fedcba9876543210fedcba9876543210fedcba98",
    });
    const refresh = await post({
      action: "refresh_acceptance",
      role: "behavior_verify",
      note: "切换到可复现的 warm retry 验收合同",
      caseIds: ["BSP-017"],
      generatedTestCaseFilePath:
        "docs/testing/beta-slot-pool-warm-retry.testplan.yaml",
      checkpointAllowedDirtyPaths: [
        "docs/testing/beta-slot-pool-warm-retry.testplan.yaml",
      ],
      checkpointExpectedHeadCommit: "0123456789abcdef0123456789abcdef01234567",
      checkpointRebasedCommit: "fedcba9876543210fedcba9876543210fedcba98",
    });
    const invalidDispatch = await post({
      action: "dispatch",
      role: "behavior_verify",
      note: "非法携带新验收文件",
      generatedTestCaseFilePath: "docs/testing/invalid.md",
    });
    const invalidRefreshWithoutCases = await post({
      action: "refresh_acceptance",
      role: "behavior_verify",
      note: "缺少影响范围",
      generatedTestCaseFilePath: "docs/testing/invalid.md",
    });
    const invalidRole = await post({
      action: "dispatch",
      role: "main_agent",
      note: "非法 worker role",
    });
    const invalidCheckpointOverride = await post({
      action: "dispatch",
      role: "code",
      note: "code 不得重锚 checkpoint",
      checkpointExpectedHeadCommit: "0123456789abcdef0123456789abcdef01234567",
    });
    const invalidReviewerDirtyOverride = await post({
      action: "dispatch",
      role: "code_review",
      note: "reviewer 不得声明 dirty checkpoint 例外",
      checkpointAllowedDirtyPaths: ["app.txt"],
    });
    check(
      "agent-intervention-route-accepts-dispatch-and-refresh",
      dispatch.ok &&
        refresh.ok &&
        acceptedInterventions.length === 2 &&
        acceptedInterventions[0]?.input.action === "dispatch" &&
        acceptedInterventions[0]?.input.role === "code_review" &&
        acceptedInterventions[0]?.input.checkpointExpectedHeadCommit ===
          "0123456789abcdef0123456789abcdef01234567" &&
        acceptedInterventions[0]?.input.checkpointRebasedCommit ===
          "fedcba9876543210fedcba9876543210fedcba98" &&
        acceptedInterventions[1]?.input.action === "refresh_acceptance" &&
        acceptedInterventions[1]?.input.generatedTestCaseFilePath ===
          "docs/testing/beta-slot-pool-warm-retry.testplan.yaml" &&
        acceptedInterventions[1]?.input.checkpointAllowedDirtyPaths?.[0] ===
          "docs/testing/beta-slot-pool-warm-retry.testplan.yaml" &&
        acceptedInterventions[1]?.input.checkpointExpectedHeadCommit ===
          "0123456789abcdef0123456789abcdef01234567" &&
        acceptedInterventions[1]?.input.checkpointRebasedCommit ===
          "fedcba9876543210fedcba9876543210fedcba98",
      { acceptedInterventions },
    );
    check(
      "agent-intervention-route-rejects-invalid-shapes",
      invalidDispatch.status === 400 &&
        invalidRefreshWithoutCases.status === 400 &&
        invalidRole.status === 400 &&
        invalidCheckpointOverride.status === 400 &&
        invalidReviewerDirtyOverride.status === 400,
      {
        invalidDispatchStatus: invalidDispatch.status,
        invalidRefreshWithoutCasesStatus: invalidRefreshWithoutCases.status,
        invalidRoleStatus: invalidRole.status,
        invalidCheckpointOverrideStatus: invalidCheckpointOverride.status,
        invalidReviewerDirtyOverrideStatus: invalidReviewerDirtyOverride.status,
      },
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export async function verifyRepairIntegration(checkResult, createRepoResult) {
  recordCheck = checkResult;
  createRepoFixture = createRepoResult;
  try {
    verifyAcceptanceRefreshPreservesCases();
    await verifyMissingAcceptanceSourceClassification();
    await verifyPersistedAcceptanceRefreshFallback();
    verifyBlockedBehaviorMainPrompt();
    await verifyRepairSourceFingerprint();
    await verifyRepairBudgetRoute();
    await verifyAgentInterventionRoute();
  } finally {
    recordCheck = null;
    createRepoFixture = null;
  }
}
