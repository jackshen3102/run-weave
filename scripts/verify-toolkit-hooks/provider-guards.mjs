import assert from "node:assert/strict";
import { processTerminalAgentHook } from "../../backend/src/terminal/agent-hook-processor.ts";
import {
  buildAgentResumeCommand,
  resolveAgentThreadToResume,
} from "../../backend/src/terminal/runtime-launcher.ts";

export async function verifyToolkitHookProviderGuards() {
  await verifyDelayedCrossProviderHookGuard();
  await verifyTmuxPaneFallbackUniqueness();
  verifyAgentThreadResumeFallback();
}

function verifyAgentThreadResumeFallback() {
  const completedTraeThread = {
    activeCommand: null,
    lastThreadId: "thread-trae-recent",
    lastThreadProvider: "traex",
  };
  const resolved = resolveAgentThreadToResume(completedTraeThread);
  assert.deepEqual(resolved, {
    provider: "traex",
    threadId: "thread-trae-recent",
  });
  assert.equal(
    buildAgentResumeCommand(resolved),
    "traex resume thread-trae-recent\n",
  );

  assert.equal(
    resolveAgentThreadToResume({
      ...completedTraeThread,
      activeCommand: "codex",
    }),
    null,
  );
  assert.equal(
    resolveAgentThreadToResume({
      ...completedTraeThread,
      lastThreadId: "",
    }),
    null,
  );
  assert.equal(
    resolveAgentThreadToResume({
      ...completedTraeThread,
      lastThreadProvider: undefined,
    }),
    null,
  );
}

async function verifyDelayedCrossProviderHookGuard() {
  const mutations = [];
  const session = {
    id: "terminal-provider-switch",
    projectId: "project-provider-switch",
    status: "running",
    activeCommand: "codex",
    threadId: "codex-current",
    threadProvider: "codex",
    terminalState: { state: "agent_idle", agent: "codex" },
  };
  const panel = {
    id: "panel-provider-switch",
    terminalSessionId: session.id,
    tmuxPaneId: "%77",
    status: "running",
    activeCommand: "codex",
    threadId: "codex-current",
    threadProvider: "codex",
    terminalState: { state: "agent_idle", agent: "codex" },
  };
  const terminalSessionManager = {
    getSession: () => session,
    getPanel: () => undefined,
    listPanels: () => [panel],
    getLastAiActiveCommand: () => null,
    updatePanelTerminalState: async (...args) => mutations.push(args),
    updateSessionLastThread: async (...args) => mutations.push(args),
    updatePanelLastThread: async (...args) => mutations.push(args),
    updateSessionThreadId: async (...args) => mutations.push(args),
    updateSessionPreview: async (...args) => mutations.push(args),
    updatePanelThreadId: async (...args) => mutations.push(args),
    updatePanelPreview: async (...args) => mutations.push(args),
  };
  const terminalStateService = {
    getCurrent: () => session.terminalState,
    handleAgentHook: (...args) => {
      mutations.push(args);
      return { state: "agent_running", agent: "trae" };
    },
  };
  const result = await processTerminalAgentHook(
    { terminalSessionManager, terminalStateService },
    {
      terminalSessionId: session.id,
      agent: "trae",
      hookEvent: "UserPromptSubmit",
      threadId: "stale-trae-thread",
      panelId: "stale-panel",
      tmuxPaneId: panel.tmuxPaneId,
      commandName: "traex",
    },
  );

  assert.equal(result.status, "ignored");
  assert.equal(result.agent, "trae");
  assert.equal(result.panelId, panel.id);
  assert.equal(session.threadId, "codex-current");
  assert.equal(session.threadProvider, "codex");
  assert.equal(panel.threadId, "codex-current");
  assert.equal(panel.threadProvider, "codex");
  assert.equal(mutations.length, 0);
}

async function verifyTmuxPaneFallbackUniqueness() {
  const session = {
    id: "terminal-pane-fallback",
    projectId: "project-pane-fallback",
    status: "running",
    activeCommand: "traex",
    terminalState: { state: "agent_idle", agent: "trae" },
  };
  const makePanel = (id, tmuxPaneId) => ({
    id,
    terminalSessionId: session.id,
    tmuxPaneId,
    status: "running",
    activeCommand: "traex",
    terminalState: { state: "agent_idle", agent: "trae" },
  });
  const run = async (panels) => {
    const mutations = [];
    const terminalSessionManager = {
      getSession: () => session,
      getPanel: () => undefined,
      listPanels: () => panels,
      getLastAiActiveCommand: () => null,
      updatePanelTerminalState: async (...args) => mutations.push(args),
    };
    const terminalStateService = {
      getCurrent: () => session.terminalState,
      handleAgentHook: (...args) => {
        mutations.push(args);
        return { state: "agent_running", agent: "trae" };
      },
    };
    const result = await processTerminalAgentHook(
      { terminalSessionManager, terminalStateService },
      {
        terminalSessionId: session.id,
        agent: "trae",
        hookEvent: "SessionStart",
        panelId: "invalid-panel",
        tmuxPaneId: "%0",
        commandName: "traex",
      },
    );
    return { mutations, result };
  };

  const unique = await run([makePanel("panel-a", "%0")]);
  assert.equal(unique.result.status, "recorded");
  assert.equal(unique.result.panelId, "panel-a");
  assert.equal(unique.mutations.length, 2);

  const duplicate = await run([
    makePanel("panel-a", "%0"),
    makePanel("panel-b", "%0"),
  ]);
  assert.equal(duplicate.result.status, "ignored");
  assert.equal(duplicate.result.panelId, null);
  assert.equal(duplicate.mutations.length, 0);

  const missing = await run([makePanel("panel-c", "%1")]);
  assert.equal(missing.result.status, "ignored");
  assert.equal(missing.result.panelId, null);
  assert.equal(missing.mutations.length, 0);
}
