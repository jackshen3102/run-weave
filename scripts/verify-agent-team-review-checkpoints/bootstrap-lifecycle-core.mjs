import { prepareTerminalAgent } from "../../backend/src/terminal/application/agent-preparation.ts";
import { processTerminalAgentHook } from "../../backend/src/terminal/agent-hook-processor.ts";
import { handleAgentLifecycleEvent } from "../../backend/src/app-server/handlers/agent-lifecycle.ts";
import { TerminalStateService } from "../../backend/src/terminal/terminal-state-service.ts";
import { TerminalStateStore } from "../../backend/src/terminal/terminal-state-store.ts";
import {
  LONG_RUNNING_COMMAND,
  PROMPT,
  captureHookMetadata,
  captureProductionHookState,
  establishReusableAgentPanel,
  prepare,
  publishIdle,
  publishRunning,
  waitForNewPanel,
  withControlledStartupDelay,
  withHarness,
} from "./bootstrap-lifecycle-harness.mjs";
import {
  verifyBootstrapReconciliationSetup,
  verifyBootstrapWorkspaceReconciliation,
} from "./bootstrap-lifecycle-reconciliation.mjs";

export async function verifyBootstrapCore(check, roots) {
  await verifyBootstrapReconciliationSetup(check, roots);
  await verifyCommandSubmissionReturnsStarting(check, roots);
  await verifyBootstrapWorkspaceReconciliation(check, roots);
  await verifyReusedPanelRespawnsAgent(check, roots);
  await verifyShellIdleExistingPanelRespawnsAgent(check, roots);
  await verifyCreatedPanelWaitsTenSeconds(check, roots);
  await verifyStaleHooksHaveNoSideEffects(check, roots);
  await verifyProductionStaleHooksHaveNoSideEffects(check, roots);
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
          0 &&
          harness.manager.getPanel(harness.panel.id)?.terminalState?.state ===
            "shell_idle",
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
          0 &&
          harness.manager.getPanel(harness.panel.id)?.terminalState?.state ===
            "shell_idle",
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
          sends[0].command.includes("RUNWEAVE_TERMINAL_AGENT_OPERATION_ID") &&
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
          0 &&
          harness.manager.getPanel(panel.id)?.terminalState?.state ===
            "shell_idle",
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
          sends[0].command.includes("RUNWEAVE_TERMINAL_AGENT_OPERATION_ID") &&
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
          result.phase === "command_submitted" &&
          result.threadId === null &&
          result.provider === "codex" &&
          result.startedAt > oldUpdatedAt.toISOString() &&
          result.commandSubmittedAt >= result.startedAt &&
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
