import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { AgentTeamService } from "../backend/src/agent-team/service.ts";
import { createTerminalPanelSplit } from "../backend/src/terminal/application/panel-split.ts";
import { cleanupOwnedAgentTeamFixtures } from "./dev-session/agent-team-fixture-cleanup.mjs";
import { resolveAgentTeamFixtureScope } from "./dev-session/agent-team-fixture-scope.mjs";
import { withHarness } from "./verify-agent-team-review-checkpoints/bootstrap-lifecycle-harness.mjs";
import { verifyDevSessionBackendIsolation } from "./verify-agent-team-fixture-lifecycle/dev-session-isolation.mjs";
import {
  buildRun,
  buildRuntimeRepairRun,
  lineage,
} from "./verify-agent-team-fixture-lifecycle/fixtures.mjs";

class FixtureLifecycleHarness extends AgentTeamService {
  write(run) {
    return this.runStore.writeRun(run);
  }

  reconcile(owner, dispatchId = null) {
    return this.reconcileOwnedFixtureResources(
      owner,
      dispatchId,
      "ATFR fixture verifier cleanup",
    );
  }

  round(run, params) {
    return this.applyRound(run, params);
  }

  resolveIdentity(input) {
    return this.resolveRunFixtureIdentity(input);
  }
}

const checks = [];
const roots = [];

function check(name, condition, detail) {
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
  checks.push(name);
}

async function verifyFixtureCleanup() {
  await withHarness(roots, async (harness) => {
    const devSessionRoot = await mkdtemp(
      path.join(os.tmpdir(), "runweave-fixture-dev-sessions-"),
    );
    roots.push(devSessionRoot);
    const childRoot = await mkdtemp(
      path.join(os.tmpdir(), "runweave-fixture-child-project-"),
    );
    roots.push(childRoot);
    const childProject = await harness.manager.createProject(
      "Fixture Child",
      childRoot,
    );
    const exclusiveFixtureSession = await harness.manager.createSession({
      projectId: childProject.id,
      command: "/bin/zsh",
      args: ["-f"],
      cwd: childRoot,
    });
    let failExclusiveCleanupOnce = true;
    const service = new FixtureLifecycleHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: {
        ...harness.options.runtimeRegistry,
        async disposeRuntime(terminalSessionId) {
          if (
            terminalSessionId === exclusiveFixtureSession.id &&
            failExclusiveCleanupOnce
          ) {
            failExclusiveCleanupOnce = false;
            throw new Error("synthetic exclusive cleanup failure");
          }
        },
      },
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
      env: { RUNWEAVE_DEV_SESSION_HOME: devSessionRoot },
    });
    const dispatchId = "dispatch-atfr-020";
    const parent = buildRun({
      runId: "atr_fixture_owner",
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
    });
    parent.activeWorkerRole = "behavior_verify";
    parent.activeWorkerDispatch = {
      dispatchId,
      role: "behavior_verify",
      panelId: harness.panel.id,
      tmuxPaneId: harness.panel.tmuxPaneId,
      round: 1,
      requestedAt: new Date().toISOString(),
      outboxMtimeMs: null,
    };
    parent.workers = [
      {
        id: "behavior-worker",
        role: "behavior_verify",
        intent: "verify fixture cleanup",
        panelId: harness.panel.id,
        tmuxPaneId: harness.panel.tmuxPaneId,
        frozen: false,
      },
    ];
    parent.acceptance = [
      {
        caseId: "ATFR-020",
        text: "fixture cleanup",
        status: "pending",
        consecutiveFail: 0,
        evidence: [],
      },
    ];
    const runningFixture = buildRun({
      runId: "atr_fixture_running",
      projectId: childProject.id,
      terminalSessionId: exclusiveFixtureSession.id,
      runKind: "verification_fixture",
      lineage: lineage(parent, dispatchId, "dvs-atfr-020", true),
    });
    const humanFixture = buildRun({
      runId: "atr_fixture_human",
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      status: "need_human",
      runKind: "verification_fixture",
      lineage: lineage(parent, dispatchId, "dvs-atfr-020", false),
    });
    const doneFixture = buildRun({
      runId: "atr_fixture_done",
      projectId: childProject.id,
      terminalSessionId: "completed-fixture-terminal",
      status: "done",
      runKind: "verification_fixture",
      lineage: lineage(parent, dispatchId, "dvs-atfr-020", true),
    });
    const legacyRun = buildRun({
      runId: "atr_legacy_primary",
      projectId: childProject.id,
      terminalSessionId: "legacy-terminal",
    });
    delete legacyRun.runKind;
    delete legacyRun.lineage;
    const { panel: sharedFixturePanel } = await createTerminalPanelSplit(
      harness.manager,
      harness.session,
      {
        ptyService: harness.options.ptyService,
        runtimeRegistry: harness.options.runtimeRegistry,
        tmuxService: harness.tmuxService,
        terminalEventService: { record() {}, subscribe() {} },
      },
      {
        direction: "right",
        alias: "fixture-worker",
        role: "agent-team:atr_fixture_human:behavior_verify",
        agentTeamRunId: humanFixture.runId,
        agentTeamWorkerId: "fixture-worker",
        cwd: childRoot,
        focus: false,
      },
    );
    humanFixture.workers = [
      {
        id: "fixture-worker",
        role: "behavior_verify",
        intent: "shared fixture worker",
        panelId: sharedFixturePanel.id,
        tmuxPaneId: sharedFixturePanel.tmuxPaneId,
        frozen: false,
      },
    ];
    await Promise.all(
      [parent, runningFixture, humanFixture, doneFixture, legacyRun].map(
        (run) => service.write(run),
      ),
    );

    const manifestDir = path.join(devSessionRoot, "dvs-atfr-020");
    const manifestPath = path.join(manifestDir, "manifest.json");
    await mkdir(manifestDir, { recursive: true });
    await writeManifest(manifestPath, parent.runId, dispatchId, "ready", null);

    const blockedRun = await service.round(parent, {
      acceptanceResults: [
        {
          caseId: "ATFR-020",
          status: "pass",
          summary: "product behavior passed",
          evidence: [],
        },
      ],
      completedWorkerRole: "behavior_verify",
      completedWorkerSummary: "fixture behavior complete",
    });
    const blocked = blockedRun.fixtureCleanupHistory.at(-1);
    const blockedScope = await service.listFixtureScope(parent.runId);
    check(
      "ATFR-020-live-runs-cancelled-with-history-preserved",
      blockedScope.ownedLiveFixtureRuns === 0 &&
        blockedScope.runs.length === 3 &&
        blockedScope.runs.find((run) => run.runId === runningFixture.runId)
          ?.status === "cancelled" &&
        blockedScope.runs.find((run) => run.runId === humanFixture.runId)
          ?.status === "cancelled" &&
        blockedScope.runs.find((run) => run.runId === doneFixture.runId)
          ?.status === "done",
      blockedScope,
    );
    check(
      "ATFR-020-shared-terminal-preserved",
      harness.manager.getSession(harness.session.id)?.id ===
        harness.session.id &&
        !harness.manager
          .getPanelWorkspace(harness.session.id)
          ?.panelIds.includes(sharedFixturePanel.id) &&
        harness.manager.getPanel(sharedFixturePanel.id)?.status === "exited",
      blockedScope,
    );
    check(
      "ATFR-021-live-dev-session-blocks-parent-completion",
      blockedRun.status === "need_human" &&
        blocked?.status === "blocked" &&
        blocked.devSessions[0]?.state === "ready" &&
        blocked.errors.some((error) =>
          error.includes("synthetic exclusive cleanup failure"),
        ) &&
        blocked.errors.some((error) => error.includes("dvs-atfr-020")),
      blockedRun,
    );

    await writeManifest(manifestPath, parent.runId, dispatchId, "stopped", {
      status: "completed",
      ownedLiveFixtureRuns: 0,
      error: null,
    });
    const completedRun = await service.completeRun(parent.runId, {
      note: "fixture cleanup recovered",
    });
    const completed = completedRun.fixtureCleanupHistory.at(-1);
    check(
      "ATFR-020-exclusive-terminal-destroyed-after-retry",
      !harness.manager.getSession(exclusiveFixtureSession.id),
      completed,
    );
    const idempotent = await service.cleanupFixtureScope({
      ownerRunId: parent.runId,
      ownerDispatchId: dispatchId,
      reason: "ATFR idempotent retry",
    });
    check(
      "ATFR-021-cleanup-retry-is-idempotent",
      completedRun.status === "done" &&
        completed?.status === "completed" &&
        completed.ownedLiveFixtureRunIds.length === 0 &&
        idempotent.ownedLiveFixtureRuns === 0 &&
        idempotent.cleanupErrors.length === 0,
      { completed, idempotent },
    );
    check(
      "ATFR-022-legacy-run-has-no-inferred-owner",
      !idempotent.runs.some((run) => run.runId === legacyRun.runId) &&
        (await service.getRun(legacyRun.runId))?.status === "running",
      idempotent,
    );
  });
}

async function verifyDevSessionScopeResolution() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "runweave-fixture-scope-resolution-"),
  );
  roots.push(root);
  const runDir = path.join(root, ".runweave", "agent-team");
  await mkdir(runDir, { recursive: true });
  const owner = buildRun({
    runId: "atr_fixture_scope_owner",
    projectId: "parent-project",
    terminalSessionId: "parent-terminal",
  });
  owner.activeWorkerRole = "behavior_verify";
  owner.activeWorkerDispatch = {
    dispatchId: "dispatch-scope-resolution",
    role: "behavior_verify",
    panelId: "behavior-panel",
    tmuxPaneId: "%3",
    round: 1,
    requestedAt: new Date().toISOString(),
    outboxMtimeMs: null,
  };
  owner.acceptance = [
    {
      caseId: "ATFR-020",
      text: "fixture cleanup",
      status: "pending",
      consecutiveFail: 0,
      evidence: [],
    },
  ];
  await writeFile(
    path.join(runDir, `${owner.runId}.json`),
    `${JSON.stringify(owner, null, 2)}\n`,
  );
  const repairOwner = buildRuntimeRepairRun(owner);
  await writeFile(
    path.join(runDir, `${repairOwner.runId}.json`),
    `${JSON.stringify(repairOwner, null, 2)}\n`,
  );
  const scope = await resolveAgentTeamFixtureScope({
    sourceRoot: root,
    sessionId: "dvs-scope-resolution",
    env: { RUNWEAVE_AGENT_TEAM_RUN_ID: owner.runId },
  });
  const inferredScope = await resolveAgentTeamFixtureScope({
    sourceRoot: root,
    sessionId: "dvs-scope-inferred",
    env: { RUNWEAVE_TERMINAL_PANEL_ID: "behavior-panel" },
  });
  let mismatchedPaneError = null;
  try {
    await resolveAgentTeamFixtureScope({
      sourceRoot: root,
      sessionId: "dvs-scope-mismatch",
      env: {
        RUNWEAVE_AGENT_TEAM_RUN_ID: owner.runId,
        RUNWEAVE_TERMINAL_PANEL_ID: "another-panel",
      },
    });
  } catch (error) {
    mismatchedPaneError = error;
  }
  const repairScope = await resolveAgentTeamFixtureScope({
    sourceRoot: root,
    sessionId: "dvs-runtime-repair",
    env: { RUNWEAVE_AGENT_TEAM_RUN_ID: repairOwner.runId },
  });
  const inferredRepairScope = await resolveAgentTeamFixtureScope({
    sourceRoot: root,
    sessionId: "dvs-runtime-repair",
    env: { RUNWEAVE_TERMINAL_PANEL_ID: "code-panel" },
  });
  let wrongRepairSessionError = null;
  try {
    await resolveAgentTeamFixtureScope({
      sourceRoot: root,
      sessionId: "dvs-another-session",
      env: { RUNWEAVE_AGENT_TEAM_RUN_ID: repairOwner.runId },
    });
  } catch (error) {
    wrongRepairSessionError = error;
  }
  check(
    "ATFR-020-dev-session-inherits-active-behavior-owner",
    scope?.ownerRunId === owner.runId &&
      scope.ownerDispatchId === owner.activeWorkerDispatch.dispatchId &&
      scope.ownerCaseIds.join(",") === "ATFR-020" &&
      scope.fixtureNamespace.includes("dvs-scope-resolution") &&
      inferredScope?.ownerRunId === owner.runId &&
      inferredScope.ownerDevSessionId === "dvs-scope-inferred" &&
      mismatchedPaneError?.exitCode === 5,
    { scope, inferredScope, mismatchedPaneError },
  );
  check(
    "ATFR-023-runtime-code-repair-recreates-verifier-session-under-new-owner",
    repairScope?.ownerRunId === repairOwner.runId &&
      repairScope.ownerDispatchId ===
        repairOwner.activeWorkerDispatch.dispatchId &&
      repairScope.ownerCaseIds.join(",") === "ATFR-020" &&
      repairScope.ownerDevSessionId === "dvs-runtime-repair" &&
      inferredRepairScope?.ownerDispatchId ===
        repairOwner.activeWorkerDispatch.dispatchId &&
      wrongRepairSessionError?.exitCode === 5,
    { repairScope, inferredRepairScope, wrongRepairSessionError },
  );
}

async function verifyCandidateBackendScopeEnforcement() {
  await withHarness(roots, async (harness) => {
    const env = {
      RUNWEAVE_AGENT_TEAM_OWNER_RUN_ID: "atr_fixture_owner",
      RUNWEAVE_AGENT_TEAM_OWNER_DISPATCH_ID: "dispatch-atfr-020",
      RUNWEAVE_AGENT_TEAM_OWNER_CASE_IDS: '["ATFR-020"]',
      RUNWEAVE_AGENT_TEAM_OWNER_DEV_SESSION_ID: "dvs-candidate-scope",
      RUNWEAVE_AGENT_TEAM_FIXTURE_NAMESPACE:
        "agent-team:atr_fixture_owner:dispatch-atfr-020:dvs-candidate-scope",
      RUNWEAVE_AGENT_TEAM_FIXTURE_OWNS_TERMINAL_SESSION: "true",
    };
    const service = new FixtureLifecycleHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
      env,
    });
    const identity = await service.resolveIdentity({
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
    });
    const currentScope = await service.listFixtureScope(
      env.RUNWEAVE_AGENT_TEAM_OWNER_RUN_ID,
    );
    let primaryError = null;
    try {
      await service.resolveIdentity({
        projectId: harness.session.projectId,
        terminalSessionId: harness.session.id,
        runKind: "primary",
      });
    } catch (error) {
      primaryError = error;
    }
    let foreignScopeError = null;
    try {
      await service.listFixtureScope("atr_foreign_owner", "dispatch-atfr-020");
    } catch (error) {
      foreignScopeError = error;
    }
    check(
      "ATFR-020-candidate-backend-enforces-environment-owner-scope",
      identity.runKind === "verification_fixture" &&
        identity.lineage?.ownerRunId === env.RUNWEAVE_AGENT_TEAM_OWNER_RUN_ID &&
        identity.lineage?.ownerDevSessionId ===
          env.RUNWEAVE_AGENT_TEAM_OWNER_DEV_SESSION_ID &&
        identity.lineage?.ownsTerminalSession === true &&
        currentScope.ownerDispatchId ===
          env.RUNWEAVE_AGENT_TEAM_OWNER_DISPATCH_ID &&
        primaryError?.statusCode === 409 &&
        foreignScopeError?.statusCode === 409,
      { identity, currentScope, primaryError, foreignScopeError },
    );
  });
}

async function verifyDevSessionCandidateCleanup() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    requests.push({
      url: request.url,
      authorization: request.headers.authorization ?? null,
      body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks)) : null,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/auth/login") {
      response.end(JSON.stringify({ accessToken: "fixture-cleanup-token" }));
      return;
    }
    if (request.url === "/api/agent-team/fixture-scopes/cleanup") {
      response.end(
        JSON.stringify({
          runs: [
            {
              runId: "atr_candidate_fixture",
              projectId: "candidate-project",
              terminalSessionId: "candidate-terminal",
              mainPanelId: "candidate-main-panel",
              workers: [{ panelId: "candidate-worker-panel" }],
            },
          ],
          cancelledRunIds: ["atr_candidate_fixture"],
          ownedLiveFixtureRuns: 0,
          cleanupErrors: [],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const receipt = await cleanupOwnedAgentTeamFixtures({
      devSessionId: "dvs-candidate-cleanup",
      state: "ready",
      controlPlane: {
        agentTeamRunId: "atr_fixture_owner",
        agentTeamDispatchId: "dispatch-atfr-020",
      },
      services: {
        backend: {
          ownership: "dedicated",
          url: `http://127.0.0.1:${address.port}`,
        },
      },
    });
    check(
      "ATFR-020-dev-session-stop-cleans-candidate-before-services",
      receipt?.status === "completed" &&
        receipt.ownedLiveFixtureRuns === 0 &&
        receipt.cancelledRunIds.join(",") === "atr_candidate_fixture" &&
        receipt.resourceLedger.runIds.join(",") === "atr_candidate_fixture" &&
        receipt.resourceLedger.terminalSessionIds.join(",") ===
          "candidate-terminal" &&
        receipt.resourceLedger.panelIds.join(",") ===
          "candidate-main-panel,candidate-worker-panel" &&
        receipt.resourceLedger.outboxIds.join(",") ===
          "candidate-project:candidate-terminal:panel:candidate-worker-panel" &&
        requests[1]?.authorization === "Bearer fixture-cleanup-token" &&
        requests[1]?.body?.ownerDispatchId === "dispatch-atfr-020",
      { receipt, requests },
    );
    const planned = await cleanupOwnedAgentTeamFixtures({
      devSessionId: "dvs-planned-cleanup",
      state: "planned",
      controlPlane: {
        agentTeamRunId: "atr_fixture_owner",
        agentTeamDispatchId: "dispatch-atfr-020",
      },
      services: {
        backend: {
          ownership: "dedicated",
          url: "http://127.0.0.1:1",
        },
      },
    });
    check(
      "ATFR-020-planned-dev-session-needs-no-candidate-cleanup",
      planned?.status === "completed" &&
        planned.ownedLiveFixtureRuns === 0 &&
        planned.resourceLedger.devSessionId === "dvs-planned-cleanup" &&
        planned.resourceLedger.runIds.length === 0 &&
        requests.length === 2,
      { planned, requests },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function writeManifest(
  manifestPath,
  ownerRunId,
  ownerDispatchId,
  state,
  fixtureCleanup,
) {
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        devSessionId: "dvs-atfr-020",
        state,
        controlPlane: {
          agentTeamRunId: ownerRunId,
          agentTeamDispatchId: ownerDispatchId,
        },
        fixtureCleanup,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  await verifyFixtureCleanup();
  await verifyDevSessionScopeResolution();
  await verifyCandidateBackendScopeEnforcement();
  await verifyDevSessionCandidateCleanup();
  verifyDevSessionBackendIsolation(check);
  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
}
