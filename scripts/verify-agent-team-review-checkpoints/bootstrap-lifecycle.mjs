import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTeamService } from "../../backend/src/agent-team/service.ts";
import { prepareTerminalAgent } from "../../backend/src/terminal/application/agent-preparation.ts";
import { processTerminalAgentHook } from "../../backend/src/terminal/agent-hook-processor.ts";
import { handleAgentLifecycleEvent } from "../../backend/src/app-server/handlers/agent-lifecycle.ts";
import { ensureTmuxPanelWorkspace } from "../../backend/src/terminal/application/panel-workspace.ts";
import { LowDbTerminalSessionStore } from "../../backend/src/terminal/lowdb-store.ts";
import { TerminalSessionManager } from "../../backend/src/terminal/manager.ts";
import { TerminalStateService } from "../../backend/src/terminal/terminal-state-service.ts";
import { TerminalStateStore } from "../../backend/src/terminal/terminal-state-store.ts";
import { TmuxService } from "../../backend/src/terminal/tmux-service.ts";
import cliPreparation from "../../packages/runweave-cli/src/commands/terminal-agent-preparation.ts";
import { DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT } from "../../packages/shared/src/terminal/agent-preparation.ts";
import { buildRepairRun } from "./repair-fixtures.mjs";

const { prepareAgentSession } = cliPreparation;

const LONG_RUNNING_COMMAND = "node -e 'setInterval(() => {}, 1000)' --";
const PROMPT = "Inspect this fixture without modifying files, then wait.";
const FORMAL_WORKER_CASE = {
  caseId: "case_2",
  text: "Code Review must find no blocking P0/P1 issues.",
  status: "pending",
  consecutiveFail: 0,
  evidence: [],
  bouncedToPanelId: null,
};

export async function verifyBootstrapLifecycle(check, roots) {
  await verifyAgentTeamFormalPromptIsInitialQuery(check, roots);
  await verifyCommandSubmissionReturnsStarting(check, roots);
  await verifyReusedPanelRespawnsAgent(check, roots);
  await verifyShellIdleExistingPanelRespawnsAgent(check, roots);
  await verifyCreatedPanelWaitsTenSeconds(check, roots);
  await verifyStaleHooksHaveNoSideEffects(check, roots);
  await verifyProductionStaleHooksHaveNoSideEffects(check, roots);
  await verifyFailedRetryRestoresPreviousGeneration(check, roots);
  await verifyPanelSingleFlight(check, roots);
  await verifyNonShellRespawnFailsClosed(check, roots);
  await verifyCreatedPanelFailureIsAtomic(check, roots);
  await verifyRespawnFailureDoesNotStartTimer(check, roots);
  await verifyCancellationDuringDelaySendsNothing(check, roots);
  await verifyPanelExitDuringDelaySendsNothing(check, roots);
  await verifyCommandSubmissionFailureFailsClosed(check, roots);
  await verifyCliPreparationCompatibility(check);
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

class AgentTeamSerialDispatchHarness extends AgentTeamService {
  persistedRuns = [];
  secondaryPromptCount = 0;

  constructor(options) {
    super(options);
    this.promptSender.sendPromptToPane = async () => {
      this.secondaryPromptCount += 1;
    };
  }

  dispatch(run, role, options) {
    return this.dispatchSerialWorker(run, role, options);
  }

  async updateRun(run, patch) {
    const next = {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.persistedRuns.push(next);
    return next;
  }
}

async function verifyReusedPanelRespawnsAgent(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness, "old-thread");
    harness.resetCaptureReadCount();
    await withControlledStartupDelay(async (clock) => {
      const preparation = prepare(harness, { command: LONG_RUNNING_COMMAND });
      await clock.waitForTimer();
      clock.advanceTo(9_999);
      check(
        "bootstrap-respawn-does-not-send-before-10000ms",
        harness.paneOperations.filter((item) => item.type === "send").length ===
          0,
        harness.paneOperations,
      );
      clock.advanceTo(10_000);
      const result = await preparation;
      check(
        "bootstrap-reused-panel-respawns-agent",
        harness.respawnedPanes.length === 1 &&
        harness.respawnedPanes[0].paneId === harness.panel.tmuxPaneId &&
        harness.paneOperations.length === 2 &&
        harness.paneOperations[0].type === "respawn" &&
        harness.paneOperations[0].paneId === harness.panel.tmuxPaneId &&
        harness.paneOperations[0].command === harness.session.command &&
        harness.paneOperations[1].type === "send" &&
        harness.paneOperations[1].command.includes(
          "RUNWEAVE_TERMINAL_AGENT_OPERATION_ID",
        ) &&
        harness.paneOperations[1].paneId === harness.panel.tmuxPaneId &&
        harness.paneOperations[1].command.includes(PROMPT) &&
        result.status === "starting" &&
        result.threadId === null &&
        harness.manager.getPanel(harness.panel.id)?.terminalState?.state ===
          "agent_starting" &&
        harness.captureReadCount() === 0,
        { paneOperations: harness.paneOperations, result },
      );
    });
  });
}

async function verifyShellIdleExistingPanelRespawnsAgent(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness, "old-shell-idle-thread");
    harness.panel.activeCommand = "export";
    await harness.manager.upsertPanel(harness.panel);
    await harness.manager.updatePanelTerminalState(harness.panel.id, {
      state: "shell_idle",
      agent: null,
    });
    harness.paneOperations.length = 0;
    harness.resetCaptureReadCount();
    await withControlledStartupDelay(async (clock) => {
      const preparation = prepare(harness, { command: LONG_RUNNING_COMMAND });
      await clock.waitForTimer();
      check(
        "bootstrap-shell-idle-existing-panel-respawns-before-delay",
        harness.respawnedPanes.length === 1 &&
          harness.paneOperations.length === 1 &&
          harness.paneOperations[0].type === "respawn" &&
          harness.paneOperations[0].paneId === harness.panel.tmuxPaneId,
        {
          respawnedPanes: harness.respawnedPanes,
          paneOperations: harness.paneOperations,
        },
      );
      clock.advanceTo(9_999);
      check(
        "bootstrap-shell-idle-existing-panel-does-not-send-before-10000ms",
        harness.paneOperations.filter((item) => item.type === "send").length ===
          0,
        harness.paneOperations,
      );
      clock.advanceTo(10_000);
      const result = await preparation;
      const sends = harness.paneOperations.filter(
        (item) => item.type === "send",
      );
      check(
        "bootstrap-shell-idle-existing-panel-sends-once-with-fresh-thread",
        sends.length === 1 &&
          sends[0].paneId === harness.panel.tmuxPaneId &&
          sends[0].command.includes(
            "RUNWEAVE_TERMINAL_AGENT_OPERATION_ID",
          ) &&
          sends[0].command.includes(PROMPT) &&
          result.createdPanel === false &&
          result.status === "starting" &&
          result.threadId === null &&
          harness.captureReadCount() === 0,
        { result, paneOperations: harness.paneOperations },
      );
    });
  });
}

async function verifyCreatedPanelWaitsTenSeconds(check, roots) {
  await withHarness(roots, async (harness) => {
    harness.paneOperations.length = 0;
    harness.resetCaptureReadCount();
    await withControlledStartupDelay(async (clock) => {
      const preparation = prepareTerminalAgent(
        harness.manager,
        harness.session,
        harness.options,
        {
          agent: "traex",
          prompt: PROMPT,
          command: LONG_RUNNING_COMMAND,
          timeoutMs: 1_000,
        },
      );
      await clock.waitForTimer();
      const panel = await waitForNewPanel(harness);
      clock.advanceTo(9_999);
      check(
        "bootstrap-created-panel-does-not-send-before-10000ms",
        harness.paneOperations.filter((item) => item.type === "send").length ===
          0,
        harness.paneOperations,
      );
      clock.advanceTo(10_000);
      const result = await preparation;
      const sends = harness.paneOperations.filter(
        (item) => item.type === "send" && item.paneId === result.tmuxPaneId,
      );
      check(
        "bootstrap-created-panel-sends-one-complete-command-at-10000ms",
        result.createdPanel === true &&
          sends.length === 1 &&
          sends[0].command.includes(
            "RUNWEAVE_TERMINAL_AGENT_OPERATION_ID",
          ) &&
          sends[0].command.includes(PROMPT) &&
          result.status === "starting" &&
          result.threadId === null &&
          harness.manager.getPanel(panel.id)?.terminalState?.state ===
            "agent_starting" &&
          harness.captureReadCount() === 0,
        { result, paneOperations: harness.paneOperations },
      );
    });
  });
}

async function verifyCommandSubmissionReturnsStarting(check, roots) {
  await withHarness(roots, async (harness) => {
    const oldUpdatedAt = new Date(Date.now() - 10_000);
    await harness.manager.updatePanelLastThread(
      harness.panel.id,
      "old-thread",
      "idle",
      oldUpdatedAt,
      "codex",
    );
    await withControlledStartupDelay(async (clock) => {
      const preparation = prepare(harness, { command: LONG_RUNNING_COMMAND });
      await clock.waitForTimer();
      clock.advanceTo(10_000);
      const result = await preparation;
      check(
        "bootstrap-command-submission-returns-starting-without-thread",
        result.status === "starting" &&
          result.threadId === null &&
          result.provider === "codex" &&
          result.startedAt > oldUpdatedAt.toISOString() &&
          harness.manager.getPanel(harness.panel.id)?.terminalState?.state ===
            "agent_starting" &&
          !harness.manager.hasPanelAgentPreparation(
            harness.session.id,
            harness.panel.id,
          ) &&
          harness.manager.matchesPanelAgentOperationGeneration(
            harness.session.id,
            harness.panel.id,
            result.operationId,
            "codex",
          ) &&
          harness.activePanelMutationListeners() === 0,
        { result, panel: harness.manager.getPanel(harness.panel.id) },
      );
      const running = await publishRunning(
        harness,
        harness.panel.id,
        "fresh-thread",
        "codex",
        result.operationId,
      );
      const beforeStale = captureHookMetadata(harness);
      const stale = await publishIdle(
        harness,
        harness.panel.id,
        "stale-thread",
        "codex",
        "stale-operation",
      );
      const afterStale = captureHookMetadata(harness);
      const idle = await publishIdle(
        harness,
        harness.panel.id,
        "fresh-thread",
        "codex",
        result.operationId,
      );
      const completedPanel = harness.manager.getPanel(harness.panel.id);
      check(
        "bootstrap-hooks-update-lifecycle-after-starting-response",
        running.status === "recorded" &&
          stale.status === "ignored" &&
          JSON.stringify(afterStale) === JSON.stringify(beforeStale) &&
          idle.status === "recorded" &&
          completedPanel?.lastThreadId === "fresh-thread" &&
          completedPanel.lastThreadStatus === "idle" &&
          completedPanel.terminalState?.state === "agent_idle",
        { running, stale, beforeStale, afterStale, idle, completedPanel },
      );
    });
  });
}

async function verifyStaleHooksHaveNoSideEffects(check, roots) {
  await withHarness(roots, async (harness) => {
    const operationId = "active-operation";
    harness.manager.beginPanelAgentPreparation(
      harness.session.id,
      harness.panel.id,
      operationId,
      "codex",
    );
    try {
      await harness.manager.updatePanelTerminalState(
        harness.panel.id,
        { state: "agent_starting", agent: "codex" },
        operationId,
      );
      const before = captureHookMetadata(harness);
      const stale = await publishRunning(
        harness,
        harness.panel.id,
        "stale-thread",
        "codex",
        "stale-operation",
      );
      const missing = await publishIdle(
        harness,
        harness.panel.id,
        "missing-operation-thread",
        "codex",
        null,
      );
      const after = captureHookMetadata(harness);
      check(
        "bootstrap-stale-and-missing-operation-hooks-have-zero-side-effects",
        stale.status === "ignored" &&
          missing.status === "ignored" &&
          JSON.stringify(after) === JSON.stringify(before),
        { before, after, stale, missing },
      );
    } finally {
      harness.manager.endPanelAgentPreparation(
        harness.session.id,
        harness.panel.id,
        operationId,
      );
    }
  });
}

async function verifyProductionStaleHooksHaveNoSideEffects(check, roots) {
  await withHarness(roots, async (harness) => {
    const starting = { state: "agent_starting", agent: "codex" };
    await harness.manager.updateSessionMetadata(harness.session.id, {
      cwd: harness.session.cwd,
      activeCommand: "codex",
    });
    harness.manager.appendOutput(harness.session.id, "OpenAI Codex\n› ");
    await harness.manager.updateSessionTerminalState(
      harness.session.id,
      starting,
    );
    harness.panel.activeCommand = "codex";
    await harness.manager.upsertPanel(harness.panel);
    await harness.manager.updatePanelTerminalState(harness.panel.id, starting);
    await harness.manager.updateSessionThreadId(
      harness.session.id,
      "session-current-thread",
      "codex",
    );
    await harness.manager.updateSessionLastThread(
      harness.session.id,
      "session-last-thread",
      "running",
      new Date(Date.now() - 2_000),
      "codex",
    );
    await harness.manager.updatePanelThreadId(
      harness.panel.id,
      "panel-current-thread",
      "codex",
    );
    await harness.manager.updatePanelLastThread(
      harness.panel.id,
      "panel-last-thread",
      "running",
      new Date(Date.now() - 1_000),
      "codex",
    );

    const terminalStateStore = new TerminalStateStore([
      [harness.session.id, starting],
    ]);
    const callbacks = [];
    const callbackUpdates = [];
    const events = [];
    const terminalStateService = new TerminalStateService(
      terminalStateStore,
      {
        record(event) {
          events.push(event);
        },
      },
      (terminalSessionId, terminalState) => {
        callbacks.push({ terminalSessionId, terminalState });
        callbackUpdates.push(
          harness.manager.updateSessionTerminalState(
            terminalSessionId,
            terminalState,
          ),
        );
      },
    );
    const operationId = "current-production-operation";
    const began = harness.manager.beginPanelAgentPreparation(
      harness.session.id,
      harness.panel.id,
      operationId,
      "codex",
    );
    if (!began) {
      throw new Error("production hook fixture could not begin preparation");
    }
    harness.manager.releasePanelAgentPreparation(
      harness.session.id,
      harness.panel.id,
      operationId,
    );

    const before = captureProductionHookState(
      harness,
      terminalStateStore,
      callbacks,
      events,
    );
    const stale = await processTerminalAgentHook(
      {
        terminalSessionManager: harness.manager,
        terminalStateService,
      },
      {
        terminalSessionId: harness.session.id,
        panelId: harness.panel.id,
        tmuxPaneId: harness.panel.tmuxPaneId,
        operationId: "stale-production-operation",
        agent: "codex",
        hookEvent: "UserPromptSubmit",
        threadId: "stale-production-thread",
      },
    );
    await Promise.all(callbackUpdates);
    const afterStale = captureProductionHookState(
      harness,
      terminalStateStore,
      callbacks,
      events,
    );
    const missing = await processTerminalAgentHook(
      {
        terminalSessionManager: harness.manager,
        terminalStateService,
      },
      {
        terminalSessionId: harness.session.id,
        panelId: harness.panel.id,
        tmuxPaneId: harness.panel.tmuxPaneId,
        operationId: null,
        agent: "codex",
        hookEvent: "Stop",
        threadId: "missing-production-thread",
      },
    );
    await Promise.all(callbackUpdates);
    const afterMissing = captureProductionHookState(
      harness,
      terminalStateStore,
      callbacks,
      events,
    );
    check(
      "bootstrap-production-stale-and-missing-hooks-have-zero-side-effects",
      stale.status === "ignored" &&
        missing.status === "ignored" &&
        !harness.manager.hasPanelAgentPreparation(
          harness.session.id,
          harness.panel.id,
        ) &&
        harness.manager.hasPanelAgentOperationGeneration(
          harness.session.id,
          harness.panel.id,
        ) &&
        JSON.stringify(afterStale) === JSON.stringify(before) &&
        JSON.stringify(afterMissing) === JSON.stringify(before),
      { before, afterStale, afterMissing, stale, missing },
    );
    const event = (threadId, provider = "codex") => ({
      id: `lifecycle-${threadId}`,
      version: 1,
      kind: "agent.lifecycle.observed",
      source: { app: "app-server", instanceId: "lifecycle-verifier" },
      scope: {
        projectId: harness.session.projectId,
        terminalSessionId: harness.session.id,
        terminalPanelId: harness.panel.id,
        terminalTmuxPaneId: harness.panel.tmuxPaneId,
        cwd: harness.session.cwd,
      },
      correlationId: threadId,
      payload: {
        source: provider,
        threadId,
        observedStatus: "idle",
        observedLifecycle: "thread/read:idle",
        lifecycleCursor: "thread/read:idle",
        detailStatus: "idle",
        compensation: true,
      },
      createdAt: new Date().toISOString(),
    });

    const beforeMismatch = captureHookMetadata(harness);
    await handleAgentLifecycleEvent(event("wrong-thread"), {
      terminalSessionManager: harness.manager,
      terminalStateService,
    });
    const afterMismatch = captureHookMetadata(harness);
    await handleAgentLifecycleEvent(event("panel-current-thread"), {
      terminalSessionManager: harness.manager,
      terminalStateService,
    });
    await Promise.all(callbackUpdates);
    const completedPanel = harness.manager.getPanel(harness.panel.id);
    const completedSession = harness.manager.getSession(harness.session.id);

    check(
      "bootstrap-trusted-current-thread-lifecycle-compensation-recorded",
      JSON.stringify(afterMismatch) === JSON.stringify(beforeMismatch) &&
        completedPanel?.terminalState?.state === "agent_idle" &&
        completedPanel.threadId == null &&
        completedPanel.lastThreadId === "panel-current-thread" &&
        completedPanel.lastThreadStatus === "idle" &&
        completedSession?.lastThreadId === "panel-current-thread" &&
        completedSession.lastThreadStatus === "idle" &&
        harness.manager.hasPanelAgentOperationGeneration(
          harness.session.id,
          harness.panel.id,
        ),
      {
        beforeMismatch,
        afterMismatch,
        completedPanel,
        completedSession,
      },
    );
  });
}

async function verifyFailedRetryRestoresPreviousGeneration(check, roots) {
  await withHarness(roots, async (harness) => {
    const running = { state: "agent_running", agent: "codex" };
    await harness.manager.updateSessionMetadata(harness.session.id, {
      cwd: harness.session.cwd,
      activeCommand: "codex",
    });
    await harness.manager.updateSessionTerminalState(
      harness.session.id,
      running,
    );
    harness.panel.activeCommand = "codex";
    await harness.manager.upsertPanel(harness.panel);
    await harness.manager.updatePanelTerminalState(harness.panel.id, running);
    await harness.manager.updateSessionThreadId(
      harness.session.id,
      "current-thread",
      "codex",
    );
    await harness.manager.updateSessionLastThread(
      harness.session.id,
      "current-thread",
      "running",
      new Date(Date.now() - 2_000),
      "codex",
    );
    await harness.manager.updatePanelThreadId(
      harness.panel.id,
      "current-thread",
      "codex",
    );
    await harness.manager.updatePanelLastThread(
      harness.panel.id,
      "current-thread",
      "running",
      new Date(Date.now() - 1_000),
      "codex",
    );

    const terminalStateStore = new TerminalStateStore([
      [harness.session.id, running],
    ]);
    const callbacks = [];
    const callbackUpdates = [];
    const events = [];
    const terminalStateService = new TerminalStateService(
      terminalStateStore,
      {
        record(event) {
          events.push(event);
        },
      },
      (terminalSessionId, terminalState) => {
        callbacks.push({ terminalSessionId, terminalState });
        callbackUpdates.push(
          harness.manager.updateSessionTerminalState(
            terminalSessionId,
            terminalState,
          ),
        );
      },
    );
    const currentOperationId = "submitted-operation-a";
    const began = harness.manager.beginPanelAgentPreparation(
      harness.session.id,
      harness.panel.id,
      currentOperationId,
      "codex",
    );
    if (!began) {
      throw new Error("retry rollback fixture could not begin operation A");
    }
    harness.manager.releasePanelAgentPreparation(
      harness.session.id,
      harness.panel.id,
      currentOperationId,
    );

    const staleHook = () =>
      processTerminalAgentHook(
        {
          terminalSessionManager: harness.manager,
          terminalStateService,
        },
        {
          terminalSessionId: harness.session.id,
          panelId: harness.panel.id,
          tmuxPaneId: harness.panel.tmuxPaneId,
          operationId: "stale-operation",
          agent: "codex",
          hookEvent: "Stop",
          threadId: "stale-thread",
        },
      );
    const initial = captureProductionHookState(
      harness,
      terminalStateStore,
      callbacks,
      events,
    );
    const beforeRetry = await staleHook();
    const afterFirstStale = captureProductionHookState(
      harness,
      terminalStateStore,
      callbacks,
      events,
    );
    const listPanes = harness.tmuxService.listPanes.bind(harness.tmuxService);
    harness.tmuxService.listPanes = async (target) =>
      (await listPanes(target)).map((pane) =>
        pane.paneId === harness.panel.tmuxPaneId
          ? {
              ...pane,
              activeCommand: "codex",
              activeCommandSource: "runweave_command",
              paneCommand: "node",
            }
          : pane,
      );
    const retryError = await captureError(() => prepare(harness));
    const afterRetry = await staleHook();
    await Promise.all(callbackUpdates);
    const final = captureProductionHookState(
      harness,
      terminalStateStore,
      callbacks,
      events,
    );

    check(
      "bootstrap-failed-retry-restores-previous-operation-generation",
      beforeRetry.status === "ignored" &&
        retryError?.statusCode === 409 &&
        retryError.message.includes("not ready") &&
        afterRetry.status === "ignored" &&
        harness.manager.matchesPanelAgentOperationGeneration(
          harness.session.id,
          harness.panel.id,
          currentOperationId,
          "codex",
        ) &&
        !harness.manager.hasPanelAgentPreparation(
          harness.session.id,
          harness.panel.id,
        ) &&
        JSON.stringify(afterFirstStale) === JSON.stringify(initial) &&
        JSON.stringify(final) === JSON.stringify(initial),
      {
        initial,
        beforeRetry,
        afterFirstStale,
        retryError: describeError(retryError),
        afterRetry,
        final,
      },
    );
  });
}

async function verifyPanelSingleFlight(check, roots) {
  await withHarness(roots, async (harness) => {
    await withControlledStartupDelay(async (clock) => {
      const first = prepare(harness);
      const secondError = await captureError(() => prepare(harness));
      await clock.waitForTimer();
      clock.advanceTo(10_000);
      const result = await first;
      check(
        "bootstrap-panel-single-flight-rejects-duplicate",
        secondError?.statusCode === 409 &&
          secondError.message.includes("already in progress") &&
          result.status === "starting" &&
          result.threadId === null &&
          harness.paneOperations.filter(
            (item) => item.type === "send" && item.command.includes(PROMPT),
          ).length === 1,
        {
          secondError: describeError(secondError),
          result,
          operations: harness.paneOperations,
        },
      );
    });
  });
}

async function verifyNonShellRespawnFailsClosed(check, roots) {
  await withHarness(roots, async (harness) => {
    const paneTarget = {
      ...harness.tmuxService.buildTarget(harness.session.id),
      paneId: harness.panel.tmuxPaneId,
    };
    await harness.tmuxService.sendInput(
      paneTarget,
      "exec node -e 'setInterval(() => {}, 1000)'\r",
    );
    await waitForPaneCommand(harness, paneTarget, "node");
    harness.session.command = process.execPath;
    harness.session.args = ["-e", "setInterval(() => {}, 1000)"];
    harness.panel.activeCommand = "codex";
    await harness.manager.upsertPanel(harness.panel);
    await harness.manager.updatePanelTerminalState(harness.panel.id, {
      state: "agent_idle",
      agent: "codex",
    });
    const error = await captureError(() => prepare(harness));
    check(
      "bootstrap-respawn-non-shell-fails-cli-launch",
      error?.details?.phase === "cli_launch",
      describeError(error),
    );
    check(
      "bootstrap-respawn-non-shell-keeps-pane-generation",
      harness.respawnedPanes.length === 0,
      harness.respawnedPanes,
    );
  });
}

async function verifyCreatedPanelFailureIsAtomic(check, roots) {
  await withHarness(roots, async (harness) => {
    const target = harness.tmuxService.buildTarget(harness.session.id);
    const panesBefore = await harness.tmuxService.listPanes(target);
    const panelsBefore = harness.manager.listPanels(harness.session.id).length;
    harness.tmuxService.setPanePanelId = async () => {
      throw new Error("fixture panel registration failure");
    };
    harness.paneOperations.length = 0;
    let error;
    let timerCount;
    await withControlledStartupDelay(async (clock) => {
      error = await captureError(() =>
        prepareTerminalAgent(
          harness.manager,
          harness.session,
          harness.options,
          {
            agent: "codex",
            prompt: PROMPT,
            command: LONG_RUNNING_COMMAND,
            timeoutMs: 1_000,
          },
        ),
      );
      timerCount = clock.timerCount();
    });
    const panesAfter = await harness.tmuxService.listPanes(target);
    const panelsAfter = harness.manager.listPanels(harness.session.id).length;
    check(
      "bootstrap-created-panel-registration-failure-is-atomic",
      error?.details?.phase === "panel_create" &&
        panesAfter.length === panesBefore.length &&
        panelsAfter === panelsBefore &&
        timerCount === 0 &&
        harness.paneOperations.every((item) => item.type !== "send"),
      {
        error: describeError(error),
        panesBefore: panesBefore.length,
        panesAfter: panesAfter.length,
        panelsBefore,
        panelsAfter,
        timerCount,
        paneOperations: harness.paneOperations,
      },
    );
  });
}

async function verifyRespawnFailureDoesNotStartTimer(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness);
    harness.tmuxService.respawnPane = async () => {
      throw new Error("fixture respawn failure");
    };
    let error;
    let timerCount;
    await withControlledStartupDelay(async (clock) => {
      error = await captureError(() => prepare(harness));
      timerCount = clock.timerCount();
    });
    check(
      "bootstrap-respawn-failure-starts-no-timer-and-sends-nothing",
      error?.details?.phase === "cli_launch" &&
        timerCount === 0 &&
        harness.paneOperations.every((item) => item.type !== "send"),
      { error: describeError(error), timerCount, paneOperations: harness.paneOperations },
    );
  });
}

async function verifyPanelExitDuringDelaySendsNothing(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness);
    await withControlledStartupDelay(async (clock) => {
      const preparation = prepare(harness);
      await clock.waitForTimer();
      await harness.manager.markPanelExited(harness.panel.id);
      clock.advanceTo(10_000);
      const error = await capturePromiseError(preparation);
      check(
        "bootstrap-panel-exit-during-delay-sends-nothing",
        error?.details?.phase === "cli_launch" &&
          harness.paneOperations.every((item) => item.type !== "send"),
        { error: describeError(error), paneOperations: harness.paneOperations },
      );
    });
  });
}

async function verifyCancellationDuringDelaySendsNothing(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness);
    await withControlledStartupDelay(async (clock) => {
      const preparation = prepare(harness);
      await clock.waitForTimer();
      harness.manager.endPanelAgentPreparation(
        harness.session.id,
        harness.panel.id,
        harness.activePreparationOperationId(),
      );
      clock.advanceTo(10_000);
      const error = await capturePromiseError(preparation);
      check(
        "bootstrap-cancellation-during-delay-sends-nothing",
        error?.details?.phase === "cli_launch" &&
          harness.paneOperations.every((item) => item.type !== "send"),
        { error: describeError(error), paneOperations: harness.paneOperations },
      );
    });
  });
}

async function verifyCommandSubmissionFailureFailsClosed(check, roots) {
  await withHarness(roots, async (harness) => {
    await establishReusableAgentPanel(harness);
    harness.tmuxService.sendKeySequence = async () => {
      throw new Error("fixture command submission failure");
    };
    await withControlledStartupDelay(async (clock) => {
      const preparation = prepare(harness);
      await clock.waitForTimer();
      clock.advanceTo(10_000);
      const error = await capturePromiseError(preparation);
      check(
        "bootstrap-command-submission-failure-fails-cli-launch",
        error?.details?.phase === "cli_launch" &&
          error.message.includes("fixture command submission failure") &&
          !harness.manager.hasPanelAgentPreparation(
            harness.session.id,
            harness.panel.id,
          ),
        describeError(error),
      );
    });
  });
}

async function verifyCliPreparationCompatibility(check) {
  const idleCodex = createCliHarness({ state: "agent_idle", agent: "codex" });
  const cleared = await prepareAgentSession({
    ...idleCodex.params,
    agent: "codex",
    agentOverwrite: true,
    agentClearCommand: "/clear-custom",
  });
  check(
    "cli-bootstrap-preserves-clear-overwrite-contract",
    cleared.status === "cleared_existing" &&
      cleared.actions.join(",") === "clear" &&
      idleCodex.inputs[0]?.data === "/clear-custom" &&
      idleCodex.preparations.length === 0,
    { cleared, inputs: idleCodex.inputs },
  );

  const idleTraex = createCliHarness({ state: "agent_idle", agent: "traex" });
  const restarted = await prepareAgentSession({
    ...idleTraex.params,
    agent: "codex",
    agentOverwrite: true,
    agentExitCommand: "/exit-custom",
    agentStartCommand: "codex --custom-flag",
    agentStartTimeoutMs: 0,
  });
  check(
    "cli-bootstrap-preserves-exit-start-timeout-contract",
    restarted.status === "restarted" &&
      restarted.actions.join(",") === "exit_existing,start" &&
      restarted.terminalState?.state === "agent_starting" &&
      restarted.threadId === null &&
      idleTraex.inputs[0]?.data === "/exit-custom" &&
      idleTraex.preparations[0]?.timeoutMs === 0 &&
      idleTraex.preparations[0]?.commandLine.includes("--custom-flag"),
    {
      restarted,
      inputs: idleTraex.inputs,
      preparations: idleTraex.preparations,
    },
  );

  const custom = createCliHarness({ state: "shell_idle", agent: null });
  const customResult = await prepareAgentSession({
    ...custom.params,
    agent: "custom-ai",
    agentStartCommand: "custom-ai --interactive",
  });
  check(
    "cli-bootstrap-preserves-custom-agent-command-contract",
    customResult.status === "started" &&
      customResult.actions.join(",") === "start" &&
      custom.inputs[0]?.data === "custom-ai --interactive",
    { customResult, inputs: custom.inputs },
  );
}

function createCliHarness(terminalState) {
  const inputs = [];
  const preparations = [];
  const panel = {
    panelId: "panel-cli",
    tmuxPaneId: "%1",
    status: "running",
    cwd: "/tmp",
    role: null,
    alias: null,
    terminalState,
  };
  const client = {
    async getSession() {
      return { status: "running" };
    },
    async listPanels() {
      return { activePanelId: panel.panelId, panels: [panel] };
    },
    async sendInput(_sessionId, payload) {
      inputs.push(payload);
      if (payload.data.startsWith("/exit")) {
        panel.terminalState = { state: "shell_idle", agent: null };
      }
      return {};
    },
    async prepareAgent(_sessionId, payload) {
      preparations.push(payload);
      panel.terminalState = { state: "agent_starting", agent: payload.agent };
      return {
        operationId: "operation-cli",
        terminalSessionId: "session-cli",
        panelId: panel.panelId,
        tmuxPaneId: panel.tmuxPaneId,
        provider: payload.agent,
        threadId: null,
        status: "starting",
        createdPanel: false,
        startedAt: new Date().toISOString(),
      };
    },
  };
  return {
    inputs,
    preparations,
    params: {
      client,
      terminalSessionId: "session-cli",
      agent: undefined,
      agentOverwrite: false,
      agentStartCommand: undefined,
      agentClearCommand: "/clear",
      agentExitCommand: undefined,
      agentStartTimeoutMs: 1_000,
      panel: undefined,
      role: undefined,
    },
  };
}

async function withHarness(roots, run) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "runweave-bootstrap-lifecycle-"),
  );
  roots.push(root);
  const socketPath = path.join(root, "tmux.sock");
  const manager = new TerminalSessionManager(
    new LowDbTerminalSessionStore(path.join(root, "terminal-sessions.json")),
  );
  let activePanelMutationListeners = 0;
  const subscribePanelMutations = manager.subscribePanelMutations.bind(manager);
  manager.subscribePanelMutations = (panelId, listener) => {
    activePanelMutationListeners += 1;
    const unsubscribe = subscribePanelMutations(panelId, listener);
    let subscribed = true;
    return () => {
      if (subscribed) {
        subscribed = false;
        activePanelMutationListeners -= 1;
      }
      unsubscribe();
    };
  };
  await manager.initialize();
  let activePreparationOperationId = null;
  const beginPanelAgentPreparation =
    manager.beginPanelAgentPreparation.bind(manager);
  manager.beginPanelAgentPreparation = (...args) => {
    const started = beginPanelAgentPreparation(...args);
    if (started) {
      activePreparationOperationId = args[2];
    }
    return started;
  };
  let session = await manager.createSession({
    command: "/bin/zsh",
    args: ["-f"],
    cwd: root,
  });
  const tmuxService = new TmuxService({ socketPath });
  let captureReadCount = 0;
  const capturePane = tmuxService.capturePane.bind(tmuxService);
  tmuxService.capturePane = async (...args) => {
    captureReadCount += 1;
    return capturePane(...args);
  };
  const respawnedPanes = [];
  const paneOperations = [];
  let currentOperationId = null;
  const setPaneOption = tmuxService.setPaneOption.bind(tmuxService);
  tmuxService.setPaneOption = async (target, name, value) => {
    if (
      name === "@runweave_agent_prepare_exit" &&
      value.startsWith("pending:")
    ) {
      currentOperationId = value.slice("pending:".length);
    }
    await setPaneOption(target, name, value);
  };
  const sendKeySequence = tmuxService.sendKeySequence.bind(tmuxService);
  let executePaneSends = true;
  tmuxService.sendKeySequence = async (target, items) => {
    paneOperations.push({
      type: "send",
      paneId: target.paneId,
      command: items
        .filter((item) => item.type === "literal")
        .map((item) => item.value)
        .join(""),
    });
    if (executePaneSends) {
      await sendKeySequence(target, items);
    }
  };
  const respawnPane = tmuxService.respawnPane.bind(tmuxService);
  tmuxService.respawnPane = async (target, params) => {
    respawnedPanes.push({
      paneId: target.paneId,
      command: params.command,
    });
    paneOperations.push({
      type: "respawn",
      paneId: target.paneId,
      command: params.command,
    });
    await respawnPane(target, params);
  };
  const tmuxTarget = tmuxService.buildTarget(session.id);
  await tmuxService.createDetachedSession(tmuxTarget, root, {
    command: session.command,
    args: session.args,
  });
  session = await manager.updateRuntimeMetadata(session.id, {
    runtimeKind: "tmux",
    tmuxSessionName: tmuxTarget.sessionName,
    tmuxSocketPath: tmuxTarget.socketPath,
    recoverable: true,
  });
  const workspace = await ensureTmuxPanelWorkspace(
    manager,
    session,
    tmuxService,
  );
  const panel = manager.getPanel(workspace.activePanelId);
  if (!panel) {
    throw new Error("bootstrap lifecycle fixture panel missing");
  }
  const runtime = {
    pid: process.pid,
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    signal() {},
    dispose() {},
  };
  const harness = {
    manager,
    session,
    panel,
    tmuxService,
    respawnedPanes,
    paneOperations,
    currentOperationId: () => currentOperationId,
    activePreparationOperationId: () => activePreparationOperationId,
    captureReadCount: () => captureReadCount,
    resetCaptureReadCount: () => {
      captureReadCount = 0;
    },
    activePanelMutationListeners: () => activePanelMutationListeners,
    setExecutePaneSends(value) {
      executePaneSends = value;
    },
    options: {
      ptyService: {},
      runtimeRegistry: {
        getRuntime(terminalSessionId) {
          return terminalSessionId === session.id ? runtime : undefined;
        },
      },
      tmuxService,
      terminalStateService: {
        getCurrent() {
          return panel.terminalState ?? { state: "shell_idle", agent: null };
        },
        handleAgentHook(_sessionId, agent, hookEvent) {
          return {
            state: hookEvent === "Stop" ? "agent_idle" : "agent_running",
            agent,
          };
        },
      },
    },
  };
  try {
    await run(harness);
  } finally {
    await manager.dispose();
    await tmuxService.killSession(tmuxTarget).catch(() => undefined);
  }
}

function prepare(harness, overrides = {}) {
  return prepareTerminalAgent(
    harness.manager,
    harness.session,
    harness.options,
    {
      agent: "codex",
      prompt: PROMPT,
      panelId: harness.panel.id,
      command: LONG_RUNNING_COMMAND,
      timeoutMs: 1_000,
      ...overrides,
    },
  );
}

async function establishReusableAgentPanel(harness, lastThreadId = null) {
  const paneTarget = {
    ...harness.tmuxService.buildTarget(harness.session.id),
    paneId: harness.panel.tmuxPaneId,
  };
  await harness.tmuxService.sendInput(
    paneTarget,
    "exec node -e 'setInterval(() => {}, 1000)'\r",
  );
  await waitForPaneCommand(harness, paneTarget, "node");
  harness.panel.activeCommand = "codex";
  await harness.manager.upsertPanel(harness.panel);
  await ensureTmuxPanelWorkspace(
    harness.manager,
    harness.session,
    harness.tmuxService,
  );
  if (lastThreadId) {
    await harness.manager.updatePanelLastThread(
      harness.panel.id,
      lastThreadId,
      "idle",
      new Date(Date.now() - 10_000),
      "codex",
    );
  }
  await harness.manager.updatePanelTerminalState(harness.panel.id, {
    state: "agent_idle",
    agent: "codex",
  });
  harness.paneOperations.length = 0;
}

async function publishRunning(
  harness,
  panelId,
  threadId,
  provider,
  operationId = harness.currentOperationId(),
) {
  return processTerminalAgentHook(
    {
      terminalSessionManager: harness.manager,
      terminalStateService: harness.options.terminalStateService,
    },
    {
      terminalSessionId: harness.session.id,
      panelId,
      tmuxPaneId: harness.manager.getPanel(panelId)?.tmuxPaneId,
      agent: provider,
      hookEvent: "UserPromptSubmit",
      threadId,
      operationId,
    },
  );
}

async function publishIdle(
  harness,
  panelId,
  threadId,
  provider,
  operationId = harness.currentOperationId(),
) {
  return processTerminalAgentHook(
    {
      terminalSessionManager: harness.manager,
      terminalStateService: harness.options.terminalStateService,
    },
    {
      terminalSessionId: harness.session.id,
      panelId,
      tmuxPaneId: harness.manager.getPanel(panelId)?.tmuxPaneId,
      agent: provider,
      hookEvent: "Stop",
      threadId,
      operationId,
    },
  );
}

async function captureError(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

async function capturePromiseError(promise) {
  return captureError(() => promise);
}

function describeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    details: error?.details ?? null,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withControlledStartupDelay(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  let elapsedMs = 0;
  globalThis.setTimeout = (callback, timeoutMs, ...args) => {
    if (timeoutMs !== 10_000) {
      return originalSetTimeout(callback, timeoutMs, ...args);
    }
    const timer = { callback, args, fired: false };
    timers.push(timer);
    return timer;
  };
  try {
    await run({
      timerCount: () => timers.length,
      async waitForTimer() {
        const deadline = Date.now() + 1_000;
        while (Date.now() <= deadline) {
          if (timers.length > 0) {
            return;
          }
          await new Promise((resolve) => originalSetTimeout(resolve, 10));
        }
        throw new Error("expected 10000ms startup delay timer");
      },
      advanceTo(nextElapsedMs) {
        if (nextElapsedMs < elapsedMs) {
          throw new Error("controlled startup clock cannot move backwards");
        }
        elapsedMs = nextElapsedMs;
        if (elapsedMs < 10_000) {
          return;
        }
        for (const timer of timers) {
          if (!timer.fired) {
            timer.fired = true;
            timer.callback(...timer.args);
          }
        }
      },
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

async function waitForNewPanel(harness) {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    const panel = harness.manager
      .listPanels(harness.session.id)
      .find((candidate) => candidate.id !== harness.panel.id);
    if (panel) {
      return panel;
    }
    await delay(10);
  }
  throw new Error("created preparation panel was not registered");
}

function captureHookMetadata(harness) {
  const session = harness.manager.getSession(harness.session.id);
  const panel = harness.manager.getPanel(harness.panel.id);
  return JSON.parse(
    JSON.stringify({
      session: {
        terminalState: session?.terminalState,
        threadId: session?.threadId,
        threadProvider: session?.threadProvider,
        lastThreadId: session?.lastThreadId,
        lastThreadProvider: session?.lastThreadProvider,
        lastThreadStatus: session?.lastThreadStatus,
        lastThreadUpdatedAt: session?.lastThreadUpdatedAt,
      },
      panel: {
        terminalState: panel?.terminalState,
        threadId: panel?.threadId,
        threadProvider: panel?.threadProvider,
        lastThreadId: panel?.lastThreadId,
        lastThreadProvider: panel?.lastThreadProvider,
        lastThreadStatus: panel?.lastThreadStatus,
        lastThreadUpdatedAt: panel?.lastThreadUpdatedAt,
      },
    }),
  );
}

function captureProductionHookState(
  harness,
  terminalStateStore,
  callbacks,
  events,
) {
  return {
    store: terminalStateStore.get(harness.session.id),
    metadata: captureHookMetadata(harness),
    callbackCount: callbacks.length,
    eventCount: events.length,
  };
}

async function waitForPaneCommand(harness, paneTarget, expected) {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    const metadata = await harness.tmuxService.readPaneMetadata(paneTarget);
    if (metadata?.paneCommand === expected) {
      return;
    }
    await delay(10);
  }
  throw new Error(`expected pane command ${expected}`);
}
