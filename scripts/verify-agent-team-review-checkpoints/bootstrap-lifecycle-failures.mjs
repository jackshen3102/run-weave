import { prepareTerminalAgent } from "../../backend/src/terminal/application/agent-preparation.ts";
import { processTerminalAgentHook } from "../../backend/src/terminal/agent-hook-processor.ts";
import { TerminalStateService } from "../../backend/src/terminal/terminal-state-service.ts";
import { TerminalStateStore } from "../../backend/src/terminal/terminal-state-store.ts";
import cliPreparation from "../../packages/runweave-cli/src/commands/terminal-agent-preparation.ts";
import {
  LONG_RUNNING_COMMAND,
  PROMPT,
  captureError,
  captureProductionHookState,
  capturePromiseError,
  describeError,
  establishReusableAgentPanel,
  prepare,
  waitForPaneCommand,
  withControlledStartupDelay,
  withHarness,
} from "./bootstrap-lifecycle-harness.mjs";

const { prepareAgentSession } = cliPreparation;

export async function verifyBootstrapFailures(check, roots) {
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
        phase: "command_submitted",
        createdPanel: false,
        startedAt: new Date().toISOString(),
        commandSubmittedAt: new Date().toISOString(),
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
