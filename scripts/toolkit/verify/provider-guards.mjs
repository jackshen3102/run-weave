import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createInternalTerminalCompletionRouter } from "../../../backend/src/routes/terminal/completion.ts";
import { createInternalTerminalAgentHookRouter } from "../../../backend/src/routes/terminal/state.ts";
import { resolveAppServerTerminalAgent } from "../../../backend/src/app-server/handlers/terminal-agent-context.ts";
import { getAgentForCommand } from "../../../backend/src/terminal/state/terminal-state-service.ts";
import { processTerminalAgentHook } from "../../../backend/src/terminal/application/agent-hook-processor.ts";
import {
  buildAgentResumeCommand,
  resolveAgentThreadToResume,
} from "../../../backend/src/terminal/runtime/launcher.ts";

export async function verifyToolkitHookProviderGuards() {
  await verifyDelayedCrossProviderHookGuard();
  await verifyTmuxPaneFallbackUniqueness();
  await verifyClaudeCapabilityIsolation();
  verifyAgentThreadResumeFallback();
  assert.equal(buildAgentResumeCommand({ provider: "claude", threadId: "session-claude" }),
    "claude --resume session-claude\n");
  assert.equal(resolveAgentThreadToResume({ activeCommand: "claude", threadId: "session-claude",
    threadProvider: "claude", terminalState: { state: "agent_idle", agent: "claude" } }), null,
    "unverified Claude lifecycle must not trigger an automatic relaunch");
}

async function verifyClaudeCapabilityIsolation() {
  const express = createRequire(new URL("../../../backend/package.json", import.meta.url))("express");
  const session = { id: "claude-isolation", projectId: "fixture", status: "running",
    activeCommand: "codex", terminalState: { state: "agent_running", agent: "codex" } };
  let mutations = 0;
  const manager = { getSession: () => session, listPanels: () => [] };
  const state = { getCurrent: () => session.terminalState };
  const app = express();
  app.use(express.json());
  app.use("/state", createInternalTerminalAgentHookRouter({ terminalSessionManager: manager,
    terminalStateService: state, hookToken: "fixture-token" }));
  app.use("/completion", createInternalTerminalCompletionRouter({ terminalSessionManager: manager,
    completionEventService: { record: () => { mutations++; throw new Error("unexpected completion"); } },
    hookToken: "fixture-token" }));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const post = (route, body, token = "fixture-token") => fetch(`http://127.0.0.1:${server.address().port}/${route}`, {
    method: "POST", headers: { "content-type": "application/json", "x-runweave-hook-token": token },
    body: JSON.stringify({ terminalSessionId: session.id, ...body }),
  });
  try {
    assert.equal(getAgentForCommand("/opt/native/claude --resume exact-id"), "claude");
    assert.equal(resolveAppServerTerminalAgent({ terminalSessionManager: manager,
      terminalSessionId: session.id, reportedSource: "claude", panelId: null,
      tmuxPaneId: null, commandName: "codex" }), null);
    assert.equal((await post("state", { agent: "claude", hookEvent: "Stop" }, "wrong-token")).status, 401);
    for (const hookEvent of ["SessionStart", "UserPromptSubmit", "Stop", "AgentMetadata", "ToolRequested", "ToolCompleted"]) {
      const response = await post("state", { agent: "claude", hookEvent,
        toolUseId: "fixture-tool", toolName: "Read", threadId: "fixture-claude" });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).disposition, "ignored");
    }
    for (const activeCommand of ["codex", "claude", null]) {
      session.activeCommand = activeCommand;
      const response = await post("completion", { source: "claude", commandName: "codex",
        completionReason: "hook_stop", rawHookEvent: "Stop", threadId: "fixture-claude" });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).reason, "claude_lifecycle_unverified");
    }
    session.activeCommand = "claude";
    const inferred = await post("completion", { source: "unknown", commandName: "claude", rawHookEvent: "Stop" });
    assert.equal((await inferred.json()).reason, "claude_lifecycle_unverified");
    assert.equal(mutations, 0);
    assert.deepEqual(session.terminalState, { state: "agent_running", agent: "codex" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function verifyAgentThreadResumeFallback() {
  const activeTraeSession = {
    activeCommand: "traex",
    lastThreadId: "thread-trae-recent",
    lastThreadProvider: "traex",
  };
  const resolved = resolveAgentThreadToResume(activeTraeSession);
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
      ...activeTraeSession,
      activeCommand: null,
      threadId: "thread-trae-stale-current",
      threadProvider: "traex",
    }),
    null,
  );
  assert.equal(
    resolveAgentThreadToResume({
      ...activeTraeSession,
      activeCommand: "codex",
    }),
    null,
  );
  assert.equal(
    resolveAgentThreadToResume({
      ...activeTraeSession,
      lastThreadId: "",
    }),
    null,
  );
  assert.equal(
    resolveAgentThreadToResume({
      ...activeTraeSession,
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
    getRecentAgentActivity: () => null,
    hasPanelAgentOperationGeneration: () => false,
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
      getRecentAgentActivity: () => null,
      hasPanelAgentOperationGeneration: () => false,
      updatePanelTerminalState: async (...args) => mutations.push(args),
    };
    const terminalStateService = {
      getCurrent: () => session.terminalState,
      handleAgentHook: (...args) => {
        mutations.push(args);
        return { state: "agent_running", agent: "trae" };
      },
      setAggregatedPanelAgentHookState(_sessionId, terminalState) {
        mutations.push([_sessionId, terminalState]);
        return terminalState;
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
