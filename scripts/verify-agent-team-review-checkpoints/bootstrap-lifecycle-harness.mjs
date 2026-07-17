import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareTerminalAgent } from "../../backend/src/terminal/application/agent-preparation.ts";
import { processTerminalAgentHook } from "../../backend/src/terminal/agent-hook-processor.ts";
import { ensureTmuxPanelWorkspace } from "../../backend/src/terminal/application/panel-workspace.ts";
import { LowDbTerminalSessionStore } from "../../backend/src/terminal/lowdb-store.ts";
import { TerminalSessionManager } from "../../backend/src/terminal/manager.ts";
import { TmuxService } from "../../backend/src/terminal/tmux-service.ts";

export const LONG_RUNNING_COMMAND = "node -e 'setInterval(() => {}, 1000)' --";
export const PROMPT = "Inspect this fixture without modifying files, then wait.";

export async function withHarness(roots, run, options = {}) {
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
  manager.beginPanelAgentPreparation = async (...args) => {
    const started = await beginPanelAgentPreparation(...args);
    if (started) {
      activePreparationOperationId = args[2];
    }
    return started;
  };
  let session = await manager.createSession({
    command: options.shell ?? "/bin/zsh",
    args: options.shellArgs ?? ["-f"],
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
        setAggregatedPanelAgentHookState(_sessionId, terminalState) {
          return terminalState;
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

export function prepare(harness, overrides = {}) {
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

export async function establishReusableAgentPanel(harness, lastThreadId = null) {
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

export async function publishRunning(
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

export async function publishIdle(
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

export async function captureError(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

export async function capturePromiseError(promise) {
  return captureError(() => promise);
}

export function describeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    details: error?.details ?? null,
  };
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withControlledStartupDelay(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  let elapsedMs = 0;
  globalThis.setTimeout = (callback, timeoutMs, ...args) => {
    const stack = new Error().stack ?? "";
    if (timeoutMs !== 10_000 || !stack.includes("agent-preparation.ts:535")) {
      return originalSetTimeout(callback, timeoutMs, ...args);
    }
    const timer = { callback, args, fired: false };
    timers.push(timer);
    return timer;
  };
  try {
    await run({
      timerCount: () => timers.length,
      async waitForTimer(timeoutMs = 1_000) {
        const deadline = Date.now() + timeoutMs;
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

export async function waitForNewPanel(harness) {
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

export function captureHookMetadata(harness) {
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

export function captureProductionHookState(
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

export async function waitForPaneCommand(harness, paneTarget, expected) {
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
