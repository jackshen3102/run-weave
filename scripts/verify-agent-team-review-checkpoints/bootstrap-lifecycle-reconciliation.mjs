import { ensureTmuxPanelWorkspace } from "../../backend/src/terminal/application/panel-workspace.ts";
import { syncExistingTmuxSessionEnvironments } from "../../backend/src/terminal/tmux-session-environment-sync.ts";
import { aggregatePanelTerminalState } from "../../backend/src/terminal/terminal-state-service.ts";
import { TERMINAL_APP_SERVER_ENV_KEYS } from "../../backend/src/terminal/runtime-environment.ts";
import {
  LONG_RUNNING_COMMAND,
  PROMPT,
  prepare,
  publishIdle,
  publishRunning,
  waitForPaneCommand,
  withControlledStartupDelay,
  withHarness,
} from "./bootstrap-lifecycle-harness.mjs";

export async function verifyBootstrapReconciliationSetup(check, roots) {
  verifyPanelStateAggregationPriority(check);
  await verifyTmuxAppServerEnvironmentRefresh(check, roots);
}

export async function verifyBootstrapWorkspaceReconciliation(check, roots) {
  await verifyStartingSurvivesWorkspaceReconcile(check, roots);
  await verifyBashStartingSurvivesWorkspaceReconcile(check, roots);
}

async function verifyTmuxAppServerEnvironmentRefresh(check, roots) {
  await withHarness(roots, async (harness) => {
    const target = harness.tmuxService.buildTarget(harness.session.id);
    const baseEnv = Object.fromEntries(
      TERMINAL_APP_SERVER_ENV_KEYS.map((key) => [key, undefined]),
    );
    const failuresA = await syncExistingTmuxSessionEnvironments(
      harness.manager,
      harness.tmuxService,
      {
        ...baseEnv,
        RUNWEAVE_APP_SERVER_DISCOVERY: "explicit",
        RUNWEAVE_APP_SERVER_HOME: "/tmp/app-server-a",
        RUNWEAVE_APP_SERVER_URL: "http://127.0.0.1:6101",
        RUNWEAVE_APP_SERVER_TOKEN: "token-a",
      },
    );
    const environmentA =
      await harness.tmuxService.readSessionEnvironment(target);
    const failuresB = await syncExistingTmuxSessionEnvironments(
      harness.manager,
      harness.tmuxService,
      {
        ...baseEnv,
        RUNWEAVE_APP_SERVER_DISCOVERY: "explicit",
        RUNWEAVE_APP_SERVER_HOME: "/tmp/app-server-b",
        RUNWEAVE_APP_SERVER_URL: "http://127.0.0.1:6102",
        RUNWEAVE_APP_SERVER_TOKEN: "token-b",
      },
    );
    const environmentB =
      await harness.tmuxService.readSessionEnvironment(target);
    const failuresDisabled = await syncExistingTmuxSessionEnvironments(
      harness.manager,
      harness.tmuxService,
      baseEnv,
    );
    const environmentDisabled =
      await harness.tmuxService.readSessionEnvironment(target);
    check(
      "bootstrap-tmux-app-server-environment-refreshes-with-backend",
      failuresA.length === 0 &&
        failuresB.length === 0 &&
        failuresDisabled.length === 0 &&
        environmentA.RUNWEAVE_APP_SERVER_URL === "http://127.0.0.1:6101" &&
        environmentB.RUNWEAVE_APP_SERVER_URL === "http://127.0.0.1:6102" &&
        environmentB.RUNWEAVE_APP_SERVER_HOME === "/tmp/app-server-b" &&
        environmentDisabled.RUNWEAVE_APP_SERVER_URL === undefined &&
        environmentDisabled.RUNWEAVE_APP_SERVER_TOKEN === undefined &&
        environmentDisabled.RUNWEAVE_APP_SERVER_HOME === undefined,
      {
        environmentA: redactAppServerEnvironment(environmentA),
        environmentB: redactAppServerEnvironment(environmentB),
        environmentDisabled: redactAppServerEnvironment(environmentDisabled),
      },
    );
  });
}

function redactAppServerEnvironment(environment) {
  return {
    ...environment,
    ...(environment.RUNWEAVE_APP_SERVER_TOKEN
      ? { RUNWEAVE_APP_SERVER_TOKEN: "<redacted>" }
      : {}),
  };
}

function verifyPanelStateAggregationPriority(check) {
  const panel = (state, agent = "codex") => ({
    activeCommand: agent,
    status: "running",
    terminalState: { state, agent },
  });
  const starting = aggregatePanelTerminalState([
    panel("agent_idle"),
    panel("agent_starting"),
  ]);
  const running = aggregatePanelTerminalState([
    panel("agent_starting"),
    panel("agent_running"),
  ]);
  check(
    "bootstrap-panel-state-aggregation-preserves-starting-priority",
    starting.state === "agent_starting" &&
      starting.agent === "codex" &&
      running.state === "agent_running" &&
      running.agent === "codex",
    { starting, running },
  );
}

async function verifyBashStartingSurvivesWorkspaceReconcile(check, roots) {
  await withHarness(
    roots,
    async (harness) => {
      await withControlledStartupDelay(async (clock) => {
        const preparation = prepare(harness, {
          commandLine: LONG_RUNNING_COMMAND,
        });
        await clock.waitForTimer();
        clock.advanceTo(10_000);
        const result = await preparation;
        await ensureTmuxPanelWorkspace(
          harness.manager,
          harness.session,
          harness.tmuxService,
        );
        const panel = harness.manager.getPanel(result.panelId);
        check(
          "bootstrap-bash-starting-survives-workspace-reconcile",
          panel?.activeCommand === "codex" &&
            panel.terminalState?.state === "agent_starting" &&
            panel.terminalState.agent === "codex",
          { result, panel },
        );
      });
    },
    { shell: "/bin/bash", shellArgs: ["--noprofile", "--norc"] },
  );
}

async function verifyStartingSurvivesWorkspaceReconcile(check, roots) {
  await withHarness(roots, async (harness) => {
    await withControlledStartupDelay(async (clock) => {
      const preparation = prepare(harness, {
        commandLine: LONG_RUNNING_COMMAND,
      });
      await clock.waitForTimer();
      clock.advanceTo(10_000);
      const result = await preparation;
      await ensureTmuxPanelWorkspace(
        harness.manager,
        harness.session,
        harness.tmuxService,
      );
      const panel = harness.manager.getPanel(result.panelId);
      const launchCommand = harness.paneOperations.find(
        (item) => item.type === "send",
      )?.command;
      check(
        "bootstrap-starting-survives-workspace-reconcile",
        panel?.activeCommand === "codex" &&
          panel.terminalState?.state === "agent_starting" &&
          panel.terminalState.agent === "codex" &&
          !panel.activeCommand.includes(PROMPT) &&
          launchCommand?.startsWith("RUNWEAVE_TERMINAL_AGENT_OPERATION_ID=") &&
          !launchCommand.includes("export RUNWEAVE_") &&
          !launchCommand.includes("unset RUNWEAVE_"),
        { result, panel, launchCommand },
      );
      const running = await publishRunning(
        harness,
        panel.id,
        "reconcile-thread",
        "codex",
        result.operationId,
      );
      await ensureTmuxPanelWorkspace(
        harness.manager,
        harness.session,
        harness.tmuxService,
      );
      const runningState = harness.manager.getPanel(result.panelId)
        ?.terminalState?.state;
      const idle = await publishIdle(
        harness,
        panel.id,
        "reconcile-thread",
        "codex",
        result.operationId,
      );
      await ensureTmuxPanelWorkspace(
        harness.manager,
        harness.session,
        harness.tmuxService,
      );
      const idleState = harness.manager.getPanel(result.panelId)?.terminalState
        ?.state;
      check(
        "bootstrap-matching-lifecycle-survives-workspace-reconcile",
        running.status === "recorded" &&
          runningState === "agent_running" &&
          idle.status === "recorded" &&
          idleState === "agent_idle",
        { running, runningState, idle, idleState },
      );
      const paneTarget = {
        ...harness.tmuxService.buildTarget(harness.session.id),
        paneId: panel.tmuxPaneId,
      };
      await harness.tmuxService.sendKeySequence(paneTarget, [
        { type: "key", key: "C-c" },
      ]);
      await waitForPaneCommand(harness, paneTarget, "zsh");
      await ensureTmuxPanelWorkspace(
        harness.manager,
        harness.session,
        harness.tmuxService,
      );
      const exitedPanel = harness.manager.getPanel(result.panelId);
      const [prepareCommand, prepareExit] = await Promise.all([
        harness.tmuxService.readPaneOption(
          paneTarget,
          "@runweave_agent_prepare_command",
        ),
        harness.tmuxService.readPaneOption(
          paneTarget,
          "@runweave_agent_prepare_exit",
        ),
      ]);
      check(
        "bootstrap-exit-marker-releases-agent-state-protection",
        exitedPanel?.terminalState?.state === "shell_idle" &&
          exitedPanel.terminalState.agent === null &&
          exitedPanel.activeCommand === null &&
          prepareCommand === null &&
          prepareExit === null,
        { result, prepareCommand, prepareExit, exitedPanel },
      );
    });
  });
}
