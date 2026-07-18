import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTeamService } from "../backend/src/agent-team/service.ts";
import { createAgentTeamPanelError } from "../backend/src/agent-team/service-run-policy.ts";
import { createActiveWorkerDispatch } from "../backend/src/agent-team/service-workflow-policy.ts";
import { TerminalPanelError } from "../backend/src/terminal/application/panel-common.ts";
import { LowDbTerminalSessionStore } from "../backend/src/terminal/lowdb-store.ts";
import { TerminalSessionManager } from "../backend/src/terminal/manager.ts";
import { TerminalRuntimeRegistry } from "../backend/src/terminal/runtime-registry.ts";

const checks = [];
let fixtureCounter = 0;
const CONTINUE_REPAIR_KEY =
  "code_review:framework-repair.continue-preserves-repair-keys";

function check(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name}: ${JSON.stringify(detail)}`);
  }
  checks.push(name);
}

async function expectConflict(action, expectedMessage) {
  try {
    await action();
  } catch (error) {
    check(
      `rejects-${expectedMessage}`,
      error?.statusCode === 409 &&
        String(error.message).includes(expectedMessage),
      { statusCode: error?.statusCode, message: error?.message },
    );
    return;
  }
  throw new Error(`expected conflict containing ${expectedMessage}`);
}

function createService(manager, root, backendInstanceId) {
  return new AgentTeamService({
    terminalSessionManager: manager,
    terminalEventService: {
      subscribe() {},
      record() {},
    },
    ptyService: {},
    runtimeRegistry: {},
    terminalStateService: {
      getCurrent() {
        return { state: "shell_idle", agent: null };
      },
    },
    cwd: root,
    backendInstanceId,
  });
}

async function createFixture(manager, root, service, overrides = {}) {
  fixtureCounter += 1;
  const project = await manager.createProject(
    `fixture-${fixtureCounter}`,
    root,
  );
  const session = await manager.createSession({
    projectId: project.id,
    command: "/bin/zsh",
    args: ["-f"],
    cwd: root,
  });
  const runId = `atr_framework_fixture_${fixtureCounter}`;
  const panelId = `panel-framework-${fixtureCounter}`;
  const paneId = `%${fixtureCounter}`;
  const now = new Date().toISOString();
  const worker = {
    id: `worker-${fixtureCounter}`,
    role: "code",
    intent: "实现 fixture",
    panelId,
    tmuxPaneId: paneId,
    frozen: false,
  };
  await manager.upsertPanel({
    id: panelId,
    terminalSessionId: session.id,
    alias: `code-${fixtureCounter}`,
    role: `agent-team:${runId}:code`,
    agentTeamRunId: runId,
    agentTeamWorkerId: worker.id,
    cwd: root,
    activeCommand: "codex",
    terminalState: { state: "agent_idle", agent: "codex" },
    status: "running",
    createdAt: new Date(),
    lastActivityAt: new Date(),
    runtimeKind: "tmux",
    tmuxPaneId: paneId,
  });
  await manager.upsertPanelWorkspace({
    terminalSessionId: session.id,
    activePanelId: panelId,
    panelIds: [panelId],
    renderMode: "tmux-native",
  });
  const activeWorkerDispatch = createActiveWorkerDispatch(
    worker,
    now,
    null,
    4,
    null,
    {
      dispatchId: `old-dispatch-${fixtureCounter}`,
      repairKeys: [CONTINUE_REPAIR_KEY],
    },
  );
  const acceptance = [
    {
      caseId: `ATFR-FIXTURE-${fixtureCounter}`,
      sourceCaseId: `ATFR-FIXTURE-${fixtureCounter}`,
      sourceFilePath: "docs/testing/fixture.md",
      text: "保留可信结果",
      status: "pass",
      consecutiveFail: 0,
      lastRunStatus: "pass",
      resultSummary: "existing pass",
      evidence: [
        {
          type: "json",
          label: "existing",
          summary: "existing evidence",
          ref: `fixture://${fixtureCounter}`,
        },
      ],
    },
  ];
  const run = {
    runId,
    projectId: project.id,
    terminalSessionId: session.id,
    mainPanelId: null,
    phase: "executing",
    status: overrides.status ?? "running",
    options: {
      autoApproveSplit: true,
      notifyMainOnHumanGate: false,
      reviewCheckpointMode:
        overrides.reviewCheckpointMode ?? "disabled",
      maxRepairAttempts: 3,
      flow: "code_first",
    },
    terminal: {
      command: "codex",
      args: [],
      cwd: root,
      runtimePreference: "auto",
    },
    task: `framework recovery fixture ${fixtureCounter}`,
    verification: null,
    reviewCheckpoint: null,
    activeWorkerRole: "code",
    activeWorkerDispatch:
      overrides.status === "need_human" ? null : activeWorkerDispatch,
    workerDispatchProtocolVersion: 1,
    consumedWorkerDispatches: [
      {
        dispatchId: `consumed-${fixtureCounter}`,
        role: "code_review",
        round: 3,
        contentSha256: "fixture-sha",
        consumedAt: now,
      },
    ],
    clarify: [],
    proposal: null,
    workers: [worker],
    acceptance,
    loop: {
      round: 4,
      noProgressCount: 1,
      maxNoProgress: 3,
      escalated: false,
      lastReason: "existing reason",
      stableFailThreshold: 2,
      errorFingerprints: ["existing-fingerprint"],
      bestPassCount: 1,
      repairCycles: [
        {
          repairKey: CONTINUE_REPAIR_KEY,
          sourceRole: "code_review",
          caseIds: [acceptance[0].caseId],
          invariant: "continue prompt preserves the code repair contract",
          verificationMode: "structural",
          sourceEvidenceRefs: ["fixture://continue-repair-contract"],
          sourceReproduction: {
            mode: "review_harness",
            status: "reproduced",
            scenarioId: "agt-r2-framework-continue-repair-handoff",
            steps: ["build the framework repair continue prompt"],
            expected: "repair contract present",
            actual: "repair contract absent",
            evidence: [
              {
                type: "command",
                label: "fixture",
                summary: "fixture prompt contract",
                ref: "fixture://continue-repair-contract",
              },
            ],
          },
          attempts: 1,
          maxAttempts: 3,
          firstFailedRound: 2,
          lastFailedRound: 3,
          lastFailureSummary: "existing failure",
        },
      ],
      maxRepairAttempts: 3,
    },
    humanNotes: [],
    findingDecisions: [],
    pendingFindingDecision: null,
    logs: ["existing log"],
    createdAt: now,
    updatedAt: now,
  };
  await service.runStore.writeRun(run);
  return { project, session, panelId, paneId, worker, run };
}

function installSuccessfulRerunHarness(service) {
  service.applySplit = async function applySplit(
    run,
    workers,
    acceptance,
    context,
  ) {
    const worker = {
      ...workers[0],
      panelId: `successor-panel-${run.runId}`,
      tmuxPaneId: `%successor-${fixtureCounter}`,
      frozen: false,
    };
    const requestedAt = new Date().toISOString();
    const activeWorkerDispatch = createActiveWorkerDispatch(
      worker,
      requestedAt,
      null,
      run.loop.round,
    );
    const next = {
      ...run,
      phase: "executing",
      status: "running",
      workers: [worker],
      acceptance,
      activeWorkerRole: worker.role,
      activeWorkerDispatch,
      logs: [...run.logs, context.log],
      updatedAt: requestedAt,
    };
    await this.runStore.writeRun(next);
    return next;
  };
}

function installFailedRerunRollbackHarness(service, root) {
  const rollbackCalls = [];
  service.createRerunReviewCheckpoint = async function createCheckpoint(
    newRunId,
  ) {
    return {
      mode: "local_commit",
      repoRoot: root,
      originalBranch: "fixture-original",
      branch: `runweave/${newRunId}`,
      taskBaseCommit: "fixture-base",
      lastReviewedCommit: "fixture-base",
      pendingReview: null,
      checkpoints: [],
      finalReviewedCommit: null,
    };
  };
  service.reviewCheckpointGit.rollbackRunBranch = async (state) => {
    rollbackCalls.push(structuredClone(state));
  };
  service.applySplit = async () => {
    const error = new Error("fixture split failure");
    error.statusCode = 409;
    throw error;
  };
  return rollbackCalls;
}

async function verifySuccessorPersistenceRollback() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "runweave-successor-persistence-"),
  );
  const manager = new TerminalSessionManager(
    new LowDbTerminalSessionStore(path.join(root, "terminal-sessions.json")),
  );
  await manager.initialize();
  try {
    const project = await manager.createProject("persistence-fixture", root);
    const session = await manager.createSession({
      projectId: project.id,
      command: "/bin/zsh",
      args: ["-f"],
      cwd: root,
    });
    await manager.updateRuntimeMetadata(session.id, {
      runtimeKind: "tmux",
      tmuxSessionName: `rw-${session.id}`,
      tmuxSocketPath: path.join(root, "tmux.sock"),
      recoverable: true,
    });
    const mainPanel = {
      id: "persistence-main-panel",
      terminalSessionId: session.id,
      alias: "main",
      role: "main",
      agentTeamRunId: null,
      agentTeamWorkerId: null,
      cwd: root,
      activeCommand: "zsh",
      terminalState: { state: "shell_idle", agent: null },
      status: "running",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      runtimeKind: "tmux",
      tmuxPaneId: "%1",
    };
    await manager.upsertPanel(mainPanel);
    await manager.upsertPanelWorkspace({
      terminalSessionId: session.id,
      activePanelId: mainPanel.id,
      panelIds: [mainPanel.id],
      renderMode: "tmux-native",
    });

    const livePanes = new Set(["%1"]);
    const panelIds = new Map();
    const rollbackKillCalls = [];
    const paneInfo = (paneId, index) => ({
      paneId,
      runweavePanelId:
        panelIds.get(paneId) ?? (paneId === "%1" ? mainPanel.id : null),
      agentPrepareCommand: null,
      agentPrepareExit: null,
      paneIndex: index,
      active: paneId === "%1",
      paneLeft: index * 80,
      paneTop: 0,
      paneWidth: 80,
      paneHeight: 24,
      windowWidth: 160,
      windowHeight: 24,
      cwd: root,
      activeCommand: "zsh",
      activeCommandSource: "pane_current_command",
      paneCommand: "zsh",
    });
    const tmuxService = {
      socketPath: path.join(root, "tmux.sock"),
      buildSessionName: (id) => `rw-${id}`,
      buildTarget: (id) => ({
        sessionName: `rw-${id}`,
        socketPath: path.join(root, "tmux.sock"),
      }),
      listPanes: async () => Array.from(livePanes).map(paneInfo),
      splitPane: async (target) => {
        livePanes.add("%2");
        return { ...target, paneId: "%2" };
      },
      setPanePanelId: async (target, panelId) => {
        panelIds.set(target.paneId, panelId);
      },
      waitForPaneReady: async () => undefined,
      readPaneMetadata: async () => ({
        cwd: root,
        activeCommand: "zsh",
      }),
      killPane: async (target) => {
        rollbackKillCalls.push(target.paneId);
        livePanes.delete(target.paneId);
      },
      selectPane: async () => undefined,
      applyMainVerticalLayout: async () => undefined,
    };
    const runtimeRegistry = new TerminalRuntimeRegistry();
    runtimeRegistry.createRuntime(session.id, {
      onData() {},
      onExit() {},
    });
    const service = new AgentTeamService({
      terminalSessionManager: manager,
      terminalEventService: { subscribe() {}, record() {} },
      ptyService: {},
      runtimeRegistry,
      terminalStateService: {
        getCurrent() {
          return { state: "shell_idle", agent: null };
        },
      },
      tmuxService,
      cwd: root,
    });
    service.runStore.writeRun = async () => {
      throw new Error("fixture successor write failure");
    };
    const now = new Date().toISOString();
    const run = {
      runId: "atr_successor_persistence_fixture",
      projectId: project.id,
      terminalSessionId: session.id,
      mainPanelId: mainPanel.id,
      phase: "intake",
      status: "running",
      options: { flow: "code_first" },
      terminal: {
        command: "codex",
        args: [],
        cwd: root,
        runtimePreference: "auto",
      },
      task: "successor persistence atomicity",
      verification: null,
      reviewCheckpoint: null,
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: [],
      frameworkRepair: null,
      predecessorRunId: "atr_blocked_fixture",
      successorRunId: null,
      clarify: [],
      proposal: null,
      workers: [],
      acceptance: [],
      loop: {
        round: 1,
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
      agentInterventions: [],
      findingDecisions: [],
      pendingFindingDecision: null,
      logs: [],
      createdAt: now,
      updatedAt: now,
    };
    let error = null;
    try {
      await service.applySplit(
        run,
        [
          {
            id: "persistence-code-worker",
            role: "code",
            intent: "fixture",
            panelId: null,
            tmuxPaneId: null,
            frozen: true,
          },
        ],
        [],
        { source: "agent", log: "fixture" },
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const runningWorkerPanels = manager
      .listPanels(session.id)
      .filter(
        (panel) =>
          panel.status === "running" && panel.agentTeamRunId === run.runId,
      )
      .map((panel) => ({
        panelId: panel.id,
        tmuxPaneId: panel.tmuxPaneId,
      }));
    check(
      "ATFR-007-successor-persistence-failure-rolls-back-worker-panes",
      error === "fixture successor write failure" &&
        !livePanes.has("%2") &&
        rollbackKillCalls.join(",") === "%2" &&
        runningWorkerPanels.length === 0,
      {
        error,
        splitPaneStillLive: livePanes.has("%2"),
        rollbackKillCalls,
        runningWorkerPanels,
      },
    );
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  await verifySuccessorPersistenceRollback();
  const root = await mkdtemp(
    path.join(os.tmpdir(), "runweave-framework-recovery-"),
  );
  const manager = new TerminalSessionManager(
    new LowDbTerminalSessionStore(path.join(root, "terminal-sessions.json")),
  );
  await manager.initialize();
  const beforeRestart = createService(manager, root, "backend-boot-a");
  const afterRestart = createService(manager, root, "backend-boot-b");
  try {
    const partialPanel = {
      panelId: "partial-panel",
      tmuxPaneId: "%99",
    };
    const sourcePanelError = new TerminalPanelError(
      500,
      "partial cleanup",
      { partialPanel },
    );
    const wrappedPanelError = createAgentTeamPanelError(
      "atr-review-harness",
      "code",
      sourcePanelError,
    );
    check(
      "ATFR-007-partial-panel-identity-survives-agent-team-wrapping",
      JSON.stringify(wrappedPanelError.details?.partialPanel) ===
        JSON.stringify(partialPanel),
      { source: sourcePanelError.details, wrapped: wrappedPanelError.details },
    );

    const fixture = await createFixture(manager, root, beforeRestart);
    const trustedAcceptance = structuredClone(fixture.run.acceptance);
    const trustedLoop = structuredClone(fixture.run.loop);
    const trustedReceipts = structuredClone(
      fixture.run.consumedWorkerDispatches,
    );
    const begun = await beforeRestart.beginFrameworkRepair(fixture.run.runId, {
      reason: "framework dispatch recovery",
    });
    check(
      "ATFR-001-begin-revokes-old-dispatch-and-preserves-history",
      begun.run.status === "need_human" &&
        begun.run.activeWorkerRole === null &&
        begun.run.activeWorkerDispatch === null &&
        begun.run.frameworkRepair?.target.invalidatedDispatch.dispatchId ===
          fixture.run.activeWorkerDispatch.dispatchId &&
        JSON.stringify(begun.run.acceptance) ===
          JSON.stringify(trustedAcceptance) &&
        JSON.stringify(begun.run.loop) === JSON.stringify(trustedLoop) &&
        JSON.stringify(begun.run.consumedWorkerDispatches) ===
          JSON.stringify(trustedReceipts) &&
        manager.getPanel(fixture.panelId)?.status === "running",
      begun.run,
    );
    const repeated = await beforeRestart.beginFrameworkRepair(
      fixture.run.runId,
      { reason: "ignored duplicate" },
    );
    check(
      "ATFR-002-repeat-begin-is-idempotent",
      repeated.run.frameworkRepair?.repairId ===
        begun.run.frameworkRepair?.repairId &&
        repeated.run.frameworkRepair?.begunAt ===
          begun.run.frameworkRepair?.begunAt &&
        repeated.run.updatedAt === begun.run.updatedAt,
      repeated.run.frameworkRepair,
    );
    const staleBefore = structuredClone(repeated.run);
    const staleConsumed = await beforeRestart.reconcileCompletionSignal({
      projectId: fixture.project.id,
      terminalSessionId: fixture.session.id,
      panelId: fixture.panelId,
      tmuxPaneId: fixture.paneId,
      cwd: root,
      source: "startup",
    });
    const staleAfter = await beforeRestart.getRun(fixture.run.runId);
    check(
      "ATFR-001-008-stale-completion-and-startup-scan-cannot-advance",
      staleConsumed === false &&
        JSON.stringify(staleAfter) === JSON.stringify(staleBefore),
      { staleConsumed, staleAfter },
    );
    await expectConflict(
      () =>
        beforeRestart.resumeRun(fixture.run.runId, {
          note: "must not bypass framework gate",
        }),
      "只能选择继续原 Run 或重新运行",
    );

    const beforeRestartStatus = await beforeRestart.getFrameworkRepairRecovery(
      fixture.run.runId,
    );
    check(
      "ATFR-005-status-distinguishes-backend-not-restarted",
      beforeRestartStatus.backendRestarted === false &&
        beforeRestartStatus.canContinue === false &&
        beforeRestartStatus.continueBlocker?.code === "backend_not_restarted" &&
        beforeRestartStatus.actions.join(",") === "continue,rerun",
      beforeRestartStatus,
    );
    const afterRestartStatus = await afterRestart.getFrameworkRepairRecovery(
      fixture.run.runId,
    );
    check(
      "ATFR-003-restart-and-exact-pane-enable-continue",
      afterRestartStatus.backendRestarted === true &&
        afterRestartStatus.canContinue === true &&
        afterRestartStatus.continueBlocker === null,
      afterRestartStatus,
    );

    const beforeFailedDelivery = await afterRestart.getRun(fixture.run.runId);
    afterRestart.submitWorkerDispatchPrompt = async () => {
      throw new Error("fixture delivery failure");
    };
    await expectConflict(
      () => afterRestart.continueFrameworkRepair(fixture.run.runId),
      "继续原 Run 投递失败",
    );
    const afterFailedDelivery = await afterRestart.getRun(fixture.run.runId);
    check(
      "ATFR-004-delivery-failure-keeps-blocked-state-retryable",
      JSON.stringify(afterFailedDelivery) ===
        JSON.stringify(beforeFailedDelivery),
      afterFailedDelivery,
    );
    let deliveredPrompt = "";
    afterRestart.submitWorkerDispatchPrompt = async (
      _run,
      _session,
      _terminal,
      _worker,
      prompt,
    ) => {
      deliveredPrompt = prompt;
    };
    const continued = await afterRestart.continueFrameworkRepair(
      fixture.run.runId,
    );
    check(
      "ATFR-003-continue-keeps-run-and-trusted-history-with-new-dispatch",
      continued.run.runId === fixture.run.runId &&
        continued.run.status === "running" &&
        continued.run.frameworkRepair?.result === "continued" &&
        continued.run.activeWorkerDispatch?.dispatchId !==
          fixture.run.activeWorkerDispatch.dispatchId &&
        JSON.stringify(continued.run.activeWorkerDispatch?.repairKeys) ===
          JSON.stringify(fixture.run.activeWorkerDispatch.repairKeys) &&
        JSON.stringify(continued.run.acceptance) ===
          JSON.stringify(trustedAcceptance) &&
        JSON.stringify(continued.run.loop) === JSON.stringify(trustedLoop) &&
        deliveredPrompt.includes(fixture.run.task) &&
        deliveredPrompt.includes(fixture.run.acceptance[0].caseId) &&
        deliveredPrompt.includes(fixture.run.activeWorkerDispatch.dispatchId) &&
        deliveredPrompt.includes(
          continued.run.activeWorkerDispatch.dispatchId,
        ) &&
        deliveredPrompt.includes(
          `.runweave/outbox/${fixture.session.id}.panel-${fixture.panelId}.json`,
        ) &&
        deliveredPrompt.includes(CONTINUE_REPAIR_KEY) &&
        deliveredPrompt.includes("fixVerifications") &&
        deliveredPrompt.includes("$toolkit:reproduce-before-fix"),
      { run: continued.run, deliveredPrompt },
    );

    const persistenceFailureFixture = await createFixture(
      manager,
      root,
      beforeRestart,
    );
    await beforeRestart.beginFrameworkRepair(persistenceFailureFixture.run.runId, {
      reason: "continue persistence after delivery",
    });
    let deliveryCount = 0;
    let deliveredDispatchId = null;
    afterRestart.submitWorkerDispatchPrompt = async (run) => {
      deliveryCount += 1;
      deliveredDispatchId = run.activeWorkerDispatch?.dispatchId ?? null;
    };
    const originalUpdateRun = afterRestart.updateRun.bind(afterRestart);
    let updateCount = 0;
    afterRestart.updateRun = async (...args) => {
      updateCount += 1;
      if (updateCount === 2) {
        throw new Error("fixture continue finalization failure");
      }
      return originalUpdateRun(...args);
    };
    await expectConflict(
      () => afterRestart.continueFrameworkRepair(persistenceFailureFixture.run.runId),
      "fixture continue finalization failure",
    );
    const pendingContinue = await afterRestart.getRun(
      persistenceFailureFixture.run.runId,
    );
    await expectConflict(
      () => afterRestart.continueFrameworkRepair(persistenceFailureFixture.run.runId),
      "禁止重复派发",
    );
    await expectConflict(
      () => afterRestart.rerunFrameworkRepair(persistenceFailureFixture.run.runId),
      "禁止重新运行",
    );
    check(
      "ATFR-003-004-continue-persistence-before-dispatch-prevents-duplicate-delivery",
      deliveryCount === 1 &&
        deliveredDispatchId !== null &&
        pendingContinue?.frameworkRepair?.result === "blocked" &&
        pendingContinue.frameworkRepair.pendingContinueDispatchId ===
          deliveredDispatchId &&
        pendingContinue.activeWorkerDispatch?.dispatchId === deliveredDispatchId,
      { pendingContinue, deliveryCount, deliveredDispatchId },
    );
    afterRestart.updateRun = originalUpdateRun;

    const unavailableFixture = await createFixture(
      manager,
      root,
      beforeRestart,
    );
    await beforeRestart.beginFrameworkRepair(unavailableFixture.run.runId, {
      reason: "pane availability",
    });
    await manager.markPanelExited(unavailableFixture.panelId, 0);
    const unavailableStatus = await afterRestart.getFrameworkRepairRecovery(
      unavailableFixture.run.runId,
    );
    check(
      "ATFR-005-missing-pane-is-a-distinct-blocker",
      unavailableStatus.backendRestarted === true &&
        unavailableStatus.canContinue === false &&
        unavailableStatus.continueBlocker?.code === "worker_pane_unavailable" &&
        unavailableStatus.actions.includes("rerun"),
      unavailableStatus,
    );
    await expectConflict(
      () => afterRestart.continueFrameworkRepair(unavailableFixture.run.runId),
      "目标 Worker pane 不可用",
    );

    const rerunFixture = await createFixture(manager, root, beforeRestart);
    await beforeRestart.beginFrameworkRepair(rerunFixture.run.runId, {
      reason: "clean rerun",
    });
    installSuccessfulRerunHarness(afterRestart);
    const rerun = await afterRestart.rerunFrameworkRepair(
      rerunFixture.run.runId,
    );
    check(
      "ATFR-006-rerun-creates-clean-bidirectionally-linked-run",
      rerun.run.status === "failed" &&
        rerun.run.frameworkRepair?.result === "rerun" &&
        rerun.run.successorRunId === rerun.successorRun?.runId &&
        rerun.successorRun?.runId !== rerunFixture.run.runId &&
        rerun.successorRun?.predecessorRunId === rerunFixture.run.runId &&
        rerun.successorRun?.task === rerunFixture.run.task &&
        JSON.stringify(rerun.successorRun?.verification) ===
          JSON.stringify(rerunFixture.run.verification) &&
        JSON.stringify(rerun.successorRun?.terminal) ===
          JSON.stringify(rerunFixture.run.terminal) &&
        JSON.stringify(rerun.successorRun?.options) ===
          JSON.stringify(rerunFixture.run.options) &&
        rerun.successorRun?.acceptance.every(
          (item) =>
            item.status === "pending" &&
            item.evidence.length === 0 &&
            item.resultSummary === null,
        ) &&
        rerun.successorRun?.loop.round === 1 &&
        rerun.successorRun?.loop.repairCycles.length === 0 &&
        rerun.successorRun?.consumedWorkerDispatches?.length === 0 &&
        rerun.successorRun?.frameworkRepair === null &&
        rerun.successorRun?.activeWorkerDispatch?.dispatchId !==
          rerunFixture.run.activeWorkerDispatch.dispatchId,
      rerun,
    );
    const selectedRun = await afterRestart.getRunByTerminalSession(
      rerunFixture.project.id,
      rerunFixture.session.id,
    );
    check(
      "ATFR-006-terminal-session-selects-active-successor",
      selectedRun?.runId === rerun.successorRun?.runId &&
        selectedRun?.predecessorRunId === rerunFixture.run.runId,
      { selectedRun, predecessor: rerun.run, successor: rerun.successorRun },
    );

    const failedRerunFixture = await createFixture(
      manager,
      root,
      beforeRestart,
      { reviewCheckpointMode: "local_commit" },
    );
    await beforeRestart.beginFrameworkRepair(failedRerunFixture.run.runId, {
      reason: "rerun retry",
    });
    const failedRerunBefore = await afterRestart.getRun(
      failedRerunFixture.run.runId,
    );
    const rollbackCalls = installFailedRerunRollbackHarness(
      afterRestart,
      root,
    );
    await expectConflict(
      () => afterRestart.rerunFrameworkRepair(failedRerunFixture.run.runId),
      "fixture split failure",
    );
    const failedRerunAfter = await afterRestart.getRun(
      failedRerunFixture.run.runId,
    );
    check(
      "ATFR-007-rerun-failure-leaves-old-run-untouched",
      JSON.stringify(failedRerunAfter) === JSON.stringify(failedRerunBefore) &&
        rollbackCalls.length === 1 &&
        rollbackCalls[0].originalBranch === "fixture-original" &&
        rollbackCalls[0].branch.startsWith("runweave/atr_"),
      { failedRerunAfter, rollbackCalls },
    );
    installSuccessfulRerunHarness(afterRestart);
    const retriedRerun = await afterRestart.rerunFrameworkRepair(
      failedRerunFixture.run.runId,
    );
    check(
      "ATFR-007-rerun-can-retry-after-input-recovers",
      retriedRerun.run.frameworkRepair?.result === "rerun" &&
        Boolean(retriedRerun.successorRun?.runId),
      retriedRerun,
    );

    const finalizationFixture = await createFixture(
      manager,
      root,
      beforeRestart,
    );
    await beforeRestart.beginFrameworkRepair(finalizationFixture.run.runId, {
      reason: "predecessor finalization rollback",
    });
    const finalizationBefore = await afterRestart.getRun(
      finalizationFixture.run.runId,
    );
    installSuccessfulRerunHarness(afterRestart);
    const writeRun = afterRestart.runStore.writeRun.bind(afterRestart.runStore);
    let persistedSuccessorId = null;
    afterRestart.runStore.writeRun = async (candidate) => {
      if (
        candidate.runId === finalizationFixture.run.runId &&
        candidate.frameworkRepair?.result === "rerun"
      ) {
        throw new Error("fixture predecessor finalization failure");
      }
      if (candidate.predecessorRunId === finalizationFixture.run.runId) {
        persistedSuccessorId = candidate.runId;
      }
      await writeRun(candidate);
    };
    await expectConflict(
      () => afterRestart.rerunFrameworkRepair(finalizationFixture.run.runId),
      "fixture predecessor finalization failure",
    );
    afterRestart.runStore.writeRun = writeRun;
    const finalizationAfter = await afterRestart.getRun(
      finalizationFixture.run.runId,
    );
    check(
      "ATFR-007-predecessor-finalization-failure-rolls-back-successor",
      JSON.stringify(finalizationAfter) === JSON.stringify(finalizationBefore) &&
        persistedSuccessorId !== null &&
        (await afterRestart.getRun(persistedSuccessorId)) === null,
      { finalizationAfter, persistedSuccessorId },
    );

    const ordinaryFixture = await createFixture(manager, root, beforeRestart, {
      status: "need_human",
    });
    afterRestart.dispatchSerialWorker = async function dispatchSerialWorker(
      run,
      role,
    ) {
      const next = {
        ...run,
        status: "running",
        activeWorkerRole: role,
        updatedAt: new Date().toISOString(),
      };
      await this.runStore.writeRun(next);
      return next;
    };
    const ordinaryResumed = await afterRestart.resumeRun(
      ordinaryFixture.run.runId,
      { note: "ordinary resume remains available" },
    );
    check(
      "ATFR-010-ordinary-run-keeps-existing-resume-behavior",
      ordinaryResumed.status === "running" &&
        ordinaryResumed.frameworkRepair === undefined,
      ordinaryResumed,
    );

    process.stdout.write(
      `${JSON.stringify({ status: "passed", checks }, null, 2)}\n`,
    );
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
