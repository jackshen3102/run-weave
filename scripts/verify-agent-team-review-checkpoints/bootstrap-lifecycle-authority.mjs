import { existsSync, readFileSync } from "node:fs";
import { TerminalStateService } from "../../backend/src/terminal/terminal-state-service.ts";
import { TerminalStateStore } from "../../backend/src/terminal/terminal-state-store.ts";
import { DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT } from "../../packages/shared/src/terminal/agent-preparation.ts";
import { buildRepairRun } from "./repair-fixtures.mjs";
import {
  establishReusableAgentPanel,
  withControlledStartupDelay,
  withHarness,
} from "./bootstrap-lifecycle-harness.mjs";
import { AgentTeamSerialDispatchHarness } from "./bootstrap-lifecycle-serial-harness.mjs";

const FORMAL_WORKER_CASE = {
  caseId: "case_2",
  text: "Code Review must find no blocking P0/P1 issues.",
  status: "pending",
  consecutiveFail: 0,
  evidence: [],
  bouncedToPanelId: null,
};

export async function verifyBootstrapAuthority(check, roots) {
  verifyTuiTextDoesNotAdvanceAuthoritativeState(check);
  verifyWorkerPanesStayFixedAcrossRechecks(check);
  await verifyInitialSplitStartsOnlyActiveWorker(check, roots);
  await verifyAgentTeamFormalPromptIsInitialQuery(check, roots);
  await verifyRecheckReusesExistingWorkerThread(check, roots);
  await verifyPersistedIdleStartingThreadWaitsForReadiness(check, roots);
  await verifyStoppedExistingThreadResumesInFixedPane(check, roots);
  await verifyUnavailableExistingThreadFailsClosed(check, roots);
}

async function verifyPersistedIdleStartingThreadWaitsForReadiness(
  check,
  roots,
) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness, "persisted-idle-thread");
    await harness.manager.updatePanelTerminalState(harness.panel.id, {
      state: "agent_starting",
      agent: "codex",
    });
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const reviewWorker = {
      ...baseRun.workers.find((worker) => worker.role === "code_review"),
      panelId: harness.panel.id,
      tmuxPaneId: harness.panel.tmuxPaneId,
    };
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      workers: [reviewWorker],
      acceptance: [FORMAL_WORKER_CASE],
      consumedWorkerDispatches: [
        {
          dispatchId: "persisted-idle-dispatch",
          role: "code_review",
          round: 1,
          contentSha256: "fixture",
          consumedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      reviewCheckpoint: null,
    };
    harness.setExecutePaneSends(false);
    const dispatch = service.dispatch(run, "code_review", {
      cases: [FORMAL_WORKER_CASE],
      log: "resume persisted idle review",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sentBeforeReady = service.secondaryPrompts.length;
    await harness.manager.updatePanelThreadId(
      harness.panel.id,
      "different-thread",
      "codex",
    );
    await harness.manager.updatePanelTerminalState(harness.panel.id, {
      state: "agent_idle",
      agent: "codex",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sentWithMismatchedIdentity = service.secondaryPrompts.length;
    await harness.manager.updatePanelThreadId(
      harness.panel.id,
      "persisted-idle-thread",
      "codex",
    );
    const result = await dispatch;
    check(
      "agent-team-persisted-idle-starting-thread-waits-for-current-thread-readiness",
      result.status === "running" &&
        result.activeWorkerRole === "code_review" &&
        sentBeforeReady === 0 &&
        sentWithMismatchedIdentity === 0 &&
        service.secondaryPrompts.length === 1 &&
        service.secondaryPrompts[0].target.panelId === harness.panel.id &&
        service.resumedThreads.length === 0 &&
        harness.respawnedPanes.length === 0,
      {
        result,
        secondaryPrompts: service.secondaryPrompts,
        resumedThreads: service.resumedThreads,
        respawnedPanes: harness.respawnedPanes,
      },
    );
  });
}

function verifyWorkerPanesStayFixedAcrossRechecks(check) {
  const recheckSource = readFileSync(
    new URL("../../backend/src/agent-team/service-recheck.ts", import.meta.url),
    "utf8",
  );
  const preparationSource = readFileSync(
    new URL(
      "../../backend/src/terminal/application/agent-preparation.ts",
      import.meta.url,
    ),
    "utf8",
  );
  check(
    "agent-team-recheck-never-replaces-fixed-worker-pane",
    !recheckSource.includes("createTerminalPanelSplit") &&
      !recheckSource.includes("replaceWorkerPaneForRecheck") &&
      !recheckSource.includes("fresh pane"),
    recheckSource.slice(0, 8_000),
  );
  check(
    "agent-team-thread-resume-preserves-fixed-worker-pane",
    preparationSource.includes(
      "reusingPanel && (!resumingThread || resetPanelBeforeResume)",
    ) &&
      preparationSource.includes("resumeThreadId") &&
      preparationSource.includes("const nextActiveCommand =") &&
      preparationSource.includes(
        "currentPanel.activeCommand = nextActiveCommand",
      ) &&
      preparationSource.indexOf(
        "reusingPanel && (!resumingThread || resetPanelBeforeResume)",
      ) <
        preparationSource.indexOf("respawnPane("),
    preparationSource.slice(0, 12_000),
  );
}

function verifyTuiTextDoesNotAdvanceAuthoritativeState(check) {
  const callbacks = [];
  const cases = [
    {
      terminalSessionId: "codex-ready-text",
      activeCommand: "codex",
      scrollback: "OpenAI Codex\n› ",
      state: { state: "agent_starting", agent: "codex" },
    },
    {
      terminalSessionId: "traex-ready-text",
      activeCommand: "traex",
      scrollback: [
        "TRAE CLI Next",
        "model: GPT-5.4 (MAX)",
        "directory: /tmp/project",
        "permissions: YOLO mode",
        "❯ Inspect the worker queue",
      ].join("\n"),
      state: { state: "agent_starting", agent: "traex" },
    },
  ];
  const store = new TerminalStateStore(
    cases.map((item) => [item.terminalSessionId, item.state]),
  );
  const service = new TerminalStateService(
    store,
    undefined,
    (terminalSessionId, state) => callbacks.push({ terminalSessionId, state }),
  );
  const results = cases.map((item) =>
    service.getCurrent(item.terminalSessionId, {
      activeCommand: item.activeCommand,
      status: "running",
      terminalState: item.state,
      scrollback: item.scrollback,
    }),
  );
  const terminalStateSource = readFileSync(
    new URL(
      "../../backend/src/terminal/terminal-state-service.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const panelWorkspaceSource = readFileSync(
    new URL(
      "../../backend/src/terminal/application/panel-workspace.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const sharedPackageSource = readFileSync(
    new URL("../../packages/shared/package.json", import.meta.url),
    "utf8",
  );
  const sharedReadinessModule = new URL(
    "../../packages/shared/src/terminal-agent-readiness.ts",
    import.meta.url,
  );
  check(
    "bootstrap-tui-text-does-not-advance-authoritative-state",
    results.every((state) => state.state === "agent_starting") &&
      callbacks.length === 0 &&
      !terminalStateSource.includes("hasAgentReadyPrompt") &&
      !terminalStateSource.includes("scrollback") &&
      !panelWorkspaceSource.includes("hasAgentReadyPrompt") &&
      !panelWorkspaceSource.includes("ready-prompt.capture") &&
      !panelWorkspaceSource.includes("capturePane(") &&
      !sharedPackageSource.includes("terminal-agent-readiness") &&
      !existsSync(sharedReadinessModule),
    { results, callbacks },
  );
}

async function verifyInitialSplitStartsOnlyActiveWorker(check, roots) {
  await withHarness(roots, async (harness) => {
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const workers = baseRun.workers
      .filter((worker) => worker.role !== "behavior_verify")
      .map((worker) => {
        const workerWithoutPanel = { ...worker };
        delete workerWithoutPanel.panelId;
        delete workerWithoutPanel.tmuxPaneId;
        return workerWithoutPanel;
      });
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      phase: "proposal",
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      workers: [],
      acceptance: [],
      proposal: {
        summary: "fixture split",
        workers,
        acceptance: [FORMAL_WORKER_CASE],
        source: "agent",
      },
    };
    harness.setExecutePaneSends(false);
    await withControlledStartupDelay(async (clock) => {
      const split = service.split(run, workers, [FORMAL_WORKER_CASE]);
      await clock.waitForTimer(15_000);
      check(
        "agent-team-initial-split-waits-once-for-active-worker",
        clock.timerCount() === 1 &&
          service.persistedRuns.length === 1 &&
          harness.respawnedPanes.length === 1 &&
          harness.paneOperations.every((item) => item.type !== "send") &&
          harness.manager
            .listPanels(harness.session.id)
            .every((panel) => panel.terminalState?.state === "shell_idle"),
        {
          timerCount: clock.timerCount(),
          persistedRuns: service.persistedRuns,
          respawnedPanes: harness.respawnedPanes,
          paneOperations: harness.paneOperations,
        },
      );
      clock.advanceTo(9_999);
      check(
        "agent-team-initial-split-does-not-send-before-10000ms",
        harness.paneOperations.every((item) => item.type !== "send"),
        harness.paneOperations,
      );
      clock.advanceTo(10_000);
      const result = await split;
      const sends = harness.paneOperations.filter(
        (item) => item.type === "send",
      );
      const activeWorker = result.workers.find(
        (worker) => worker.role === result.activeWorkerRole,
      );
      check(
        "agent-team-initial-split-submits-formal-prompt-as-only-initial-query",
        sends.length === 1 &&
          sends[0].paneId === activeWorker?.tmuxPaneId &&
          sends[0].command.includes("你是本 run 的 worker：") &&
          sends[0].command.includes(`任务：${run.task}`) &&
          !sends[0].command.includes(DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT) &&
          service.secondaryPromptCount === 0 &&
          result.workers.filter((worker) => !worker.frozen).length === 1,
        { sends, activeWorker, result },
      );
    });
  });
}

async function verifyAgentTeamFormalPromptIsInitialQuery(check, roots) {
  await withHarness(roots, async (harness) => {
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const reviewWorker = baseRun.workers.find(
      (worker) => worker.role === "code_review",
    );
    if (!reviewWorker) {
      throw new Error("serial dispatch fixture review worker missing");
    }
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      workers: baseRun.workers.map((worker) =>
        worker.role === "code_review"
          ? {
              ...worker,
              panelId: harness.panel.id,
              tmuxPaneId: harness.panel.tmuxPaneId,
            }
          : worker,
      ),
      acceptance: [FORMAL_WORKER_CASE],
      reviewCheckpoint: null,
    };
    harness.setExecutePaneSends(false);
    await withControlledStartupDelay(async (clock) => {
      const dispatch = service.dispatch(run, "code_review", {
        cases: [FORMAL_WORKER_CASE],
        log: "code completed, start review",
      });
      await clock.waitForTimer();
      check(
        "agent-team-serial-dispatch-persists-boundary-before-agent-launch",
        service.persistedRuns.length === 1 &&
          service.persistedRuns[0].activeWorkerRole === "code_review" &&
          service.persistedRuns[0].activeWorkerDispatch?.panelId ===
            harness.panel.id &&
          harness.paneOperations.every((item) => item.type !== "send"),
        {
          persistedRuns: service.persistedRuns,
          paneOperations: harness.paneOperations,
        },
      );
      clock.advanceTo(10_000);
      const result = await dispatch;
      const sends = harness.paneOperations.filter(
        (item) => item.type === "send",
      );
      check(
        "agent-team-serial-dispatch-submits-formal-prompt-as-only-initial-query",
        sends.length === 1 &&
          sends[0].paneId === harness.panel.tmuxPaneId &&
          sends[0].command.includes("[loop round") &&
          sends[0].command.includes(FORMAL_WORKER_CASE.text) &&
          !sends[0].command.includes(DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT) &&
          service.secondaryPromptCount === 0 &&
          result.activeWorkerDispatch?.panelId === harness.panel.id,
        {
          sends,
          secondaryPromptCount: service.secondaryPromptCount,
          result,
        },
      );
    });
  });
}

async function verifyRecheckReusesExistingWorkerThread(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness, "old-review-thread");
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const reviewWorker = {
      ...baseRun.workers.find((worker) => worker.role === "code_review"),
      panelId: harness.panel.id,
      tmuxPaneId: harness.panel.tmuxPaneId,
    };
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      activeWorkerRole: "code_review",
      workers: [reviewWorker],
      acceptance: [FORMAL_WORKER_CASE],
      reviewCheckpoint: null,
    };
    harness.setExecutePaneSends(false);
    const result = await service.recheck(run, harness.session, reviewWorker, [
      FORMAL_WORKER_CASE,
    ]);
    check(
      "agent-team-recheck-persists-boundary-before-reusing-thread",
      service.persistedRuns.length === 1 &&
        harness.respawnedPanes.length === 0 &&
        harness.paneOperations.every((item) => item.type !== "send"),
      {
        persistedRuns: service.persistedRuns,
        paneOperations: harness.paneOperations,
      },
    );
    check(
      "agent-team-recheck-reuses-existing-worker-thread",
      service.secondaryPrompts.length === 1 &&
        service.secondaryPrompts[0].text.includes(FORMAL_WORKER_CASE.text) &&
        service.secondaryPrompts[0].target.panelId === harness.panel.id &&
        result.activeWorkerDispatch?.panelId === harness.panel.id,
      { secondaryPrompts: service.secondaryPrompts, result },
    );
  });
}

async function verifyStoppedExistingThreadResumesInFixedPane(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness, "old-review-thread");
    await harness.manager.updatePanelTerminalState(harness.panel.id, {
      state: "shell_idle",
      agent: null,
    });
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const reviewWorker = {
      ...baseRun.workers.find((worker) => worker.role === "code_review"),
      panelId: harness.panel.id,
      tmuxPaneId: harness.panel.tmuxPaneId,
    };
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      workers: [reviewWorker],
      acceptance: [FORMAL_WORKER_CASE],
      consumedWorkerDispatches: [
        {
          dispatchId: "old-review-dispatch",
          role: "code_review",
          round: 1,
          contentSha256: "fixture",
          consumedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      reviewCheckpoint: null,
    };
    harness.setExecutePaneSends(false);
    const result = await service.dispatch(run, "code_review", {
      cases: [FORMAL_WORKER_CASE],
      log: "retry review",
    });
    check(
      "agent-team-stopped-thread-resumes-in-fixed-worker-pane",
      result.status === "running" &&
        result.activeWorkerRole === "code_review" &&
        service.resumedThreads.length === 1 &&
        service.resumedThreads[0].target.panelId === harness.panel.id &&
        service.resumedThreads[0].target.threadId === "old-review-thread" &&
        service.resumedThreads[0].target.prompt.includes(
          FORMAL_WORKER_CASE.text,
        ) &&
        harness.respawnedPanes.length === 0 &&
        harness.paneOperations.every((item) => item.type !== "send") &&
        service.secondaryPrompts.length === 0,
      {
        result,
        resumedThreads: service.resumedThreads,
        respawnedPanes: harness.respawnedPanes,
        paneOperations: harness.paneOperations,
        secondaryPrompts: service.secondaryPrompts,
      },
    );
  });
}

async function verifyUnavailableExistingThreadFailsClosed(check, roots) {
  await withHarness(roots, async (harness) => {
    const service = new AgentTeamSerialDispatchHarness({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
    });
    const baseRun = buildRepairRun();
    const reviewWorker = {
      ...baseRun.workers.find((worker) => worker.role === "code_review"),
      panelId: harness.panel.id,
      tmuxPaneId: harness.panel.tmuxPaneId,
    };
    const run = {
      ...baseRun,
      projectId: harness.session.projectId,
      terminalSessionId: harness.session.id,
      terminal: {
        command: "codex",
        args: [],
        cwd: harness.session.cwd,
      },
      workers: [reviewWorker],
      acceptance: [FORMAL_WORKER_CASE],
      consumedWorkerDispatches: [
        {
          dispatchId: "old-review-dispatch",
          role: "code_review",
          round: 1,
          contentSha256: "fixture",
          consumedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      reviewCheckpoint: null,
    };
    harness.setExecutePaneSends(false);
    const result = await service.dispatch(run, "code_review", {
      cases: [FORMAL_WORKER_CASE],
      log: "retry review",
    });
    check(
      "agent-team-existing-thread-unavailable-fails-closed",
      result.status === "need_human" &&
        result.activeWorkerRole === "code_review" &&
        result.logs.some((item) => item.includes("禁止新开 thread")) &&
        harness.respawnedPanes.length === 0 &&
        harness.paneOperations.every((item) => item.type !== "send") &&
        service.secondaryPrompts.length === 0 &&
        service.resumedThreads.length === 0,
      {
        result,
        resumedThreads: service.resumedThreads,
        respawnedPanes: harness.respawnedPanes,
        paneOperations: harness.paneOperations,
        secondaryPrompts: service.secondaryPrompts,
      },
    );
  });
}
