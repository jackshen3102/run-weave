import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { captureRepairSourceFingerprint } from "../../backend/src/agent-team/repair-source-fingerprint.ts";
import { createAgentTeamRouter } from "../../backend/src/routes/agent-team.ts";

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
    const post = (maxRepairAttempts) =>
      fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project",
          terminalSessionId: "terminal",
          task: "fixture",
          options: maxRepairAttempts === undefined ? {} : { maxRepairAttempts },
        }),
      });
    const invalidLow = await post(0);
    const invalidHigh = await post(6);
    const validLow = await post(1);
    const validHigh = await post(5);
    const validDefault = await post(undefined);
    check(
      "repair-budget-route-enforces-one-to-five",
      invalidLow.status === 400 &&
        invalidHigh.status === 400 &&
        validLow.ok &&
        validHigh.ok &&
        validDefault.ok &&
        acceptedOptions.length === 3 &&
        acceptedOptions[0]?.maxRepairAttempts === 1 &&
        acceptedOptions[1]?.maxRepairAttempts === 5 &&
        acceptedOptions[2]?.maxRepairAttempts === undefined,
      {
        statuses: [
          invalidLow.status,
          invalidHigh.status,
          validLow.status,
          validHigh.status,
          validDefault.status,
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
    });
    const refresh = await post({
      action: "refresh_acceptance",
      role: "behavior_verify",
      note: "切换到可复现的 warm retry 验收合同",
      caseIds: ["BSP-017"],
      generatedTestCaseFilePath:
        "docs/testing/beta-slot-pool-warm-retry-test-cases.md",
      checkpointAllowedDirtyPaths: [
        "docs/testing/beta-slot-pool-warm-retry-test-cases.md",
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
    const invalidRole = await post({
      action: "dispatch",
      role: "main_agent",
      note: "非法 worker role",
    });
    const invalidCheckpointOverride = await post({
      action: "dispatch",
      role: "code_review",
      note: "reviewer 不得使用 behavior checkpoint 例外",
      checkpointAllowedDirtyPaths: ["app.txt"],
    });
    check(
      "agent-intervention-route-accepts-dispatch-and-refresh",
      dispatch.ok &&
        refresh.ok &&
        acceptedInterventions.length === 2 &&
        acceptedInterventions[0]?.input.action === "dispatch" &&
        acceptedInterventions[0]?.input.role === "code_review" &&
        acceptedInterventions[1]?.input.action === "refresh_acceptance" &&
        acceptedInterventions[1]?.input.generatedTestCaseFilePath ===
          "docs/testing/beta-slot-pool-warm-retry-test-cases.md" &&
        acceptedInterventions[1]?.input.checkpointAllowedDirtyPaths?.[0] ===
          "docs/testing/beta-slot-pool-warm-retry-test-cases.md" &&
        acceptedInterventions[1]?.input.checkpointExpectedHeadCommit ===
          "0123456789abcdef0123456789abcdef01234567" &&
        acceptedInterventions[1]?.input.checkpointRebasedCommit ===
          "fedcba9876543210fedcba9876543210fedcba98",
      { acceptedInterventions },
    );
    check(
      "agent-intervention-route-rejects-invalid-shapes",
      invalidDispatch.status === 400 &&
        invalidRole.status === 400 &&
        invalidCheckpointOverride.status === 400,
      {
        invalidDispatchStatus: invalidDispatch.status,
        invalidRoleStatus: invalidRole.status,
        invalidCheckpointOverrideStatus: invalidCheckpointOverride.status,
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
    await verifyRepairSourceFingerprint();
    await verifyRepairBudgetRoute();
    await verifyAgentInterventionRoute();
  } finally {
    recordCheck = null;
    createRepoFixture = null;
  }
}
