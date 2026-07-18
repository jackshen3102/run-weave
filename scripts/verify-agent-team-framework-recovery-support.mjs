import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTeamService } from "../backend/src/agent-team/service.ts";
import { createActiveWorkerDispatch } from "../backend/src/agent-team/service-workflow-policy.ts";
import { LowDbTerminalSessionStore } from "../backend/src/terminal/lowdb-store.ts";
import { TerminalSessionManager } from "../backend/src/terminal/manager.ts";
import { TerminalRuntimeRegistry } from "../backend/src/terminal/runtime-registry.ts";

export const checks = [];
let fixtureCounter = 0;
export const CONTINUE_REPAIR_KEY =
  "code_review:framework-repair.continue-preserves-repair-keys";

export function check(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name}: ${JSON.stringify(detail)}`);
  }
  checks.push(name);
}

export async function expectConflict(action, expectedMessage) {
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

export function createService(manager, root, backendInstanceId) {
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

export async function createFixture(manager, root, service, overrides = {}) {
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
      reviewCheckpointMode: overrides.reviewCheckpointMode ?? "disabled",
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

export function installSuccessfulRerunHarness(service) {
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

export function installFailedRerunRollbackHarness(service, root) {
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

export async function verifySuccessorPersistenceRollback() {
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
