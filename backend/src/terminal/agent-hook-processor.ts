import type {
  AgentHookIgnoreReason,
  AgentHookStateEvent,
} from "@runweave/shared/terminal/events";
import type { TerminalLastThreadStatus } from "@runweave/shared/terminal/session";
import type {
  TerminalAgentKind,
  TerminalState,
} from "@runweave/shared/terminal/state";
import { logger } from "../logging";
import {
  AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS,
  getCompletionSourceForCommand,
  isCompletionSourceAllowedForCommand,
} from "./completion-source-gate";
import type { TerminalSessionManager } from "./manager";
import {
  aggregatePanelTerminalState,
  getTerminalSessionAgent,
  resolveAgentHookTerminalState,
  type TerminalStateService,
} from "./terminal-state-service";
import { readCodexThreadSnapshot } from "./codex-thread-snapshot";

const agentHookProcessorLogger = logger.child({
  component: "terminal-agent-hook",
});

function getLastThreadStatusForHookEvent(
  hookEvent: AgentHookStateEvent,
): TerminalLastThreadStatus {
  return hookEvent === "UserPromptSubmit" ? "running" : "idle";
}

export interface ProcessTerminalAgentHookInput {
  terminalSessionId: string;
  operationId?: string | null;
  agent: TerminalAgentKind;
  hookEvent: AgentHookStateEvent;
  threadId?: string | null;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  commandName?: string | null;
}

interface ProcessTerminalAgentHookContext {
  currentThreadIdentityMatched?: boolean;
}

export type ProcessTerminalAgentHookResult =
  | {
      status: "not_found";
      terminalSessionId: string;
    }
  | {
      status: "exited";
      terminalSessionId: string;
      terminalState: TerminalState;
    }
  | {
      status: "ignored";
      terminalSessionId: string;
      agent: TerminalAgentKind;
      hookEvent: AgentHookStateEvent;
      activeCommand: string | null;
      terminalState: TerminalState;
      panelId: string | null;
      ignoreReason: AgentHookIgnoreReason;
    }
  | {
      status: "recorded";
      terminalSessionId: string;
      agent: TerminalAgentKind;
      hookEvent: AgentHookStateEvent;
      terminalState: TerminalState;
      panelId: string | null;
    };

export async function processTerminalAgentHook(
  options: {
    terminalSessionManager: TerminalSessionManager;
    terminalStateService: TerminalStateService;
  },
  input: ProcessTerminalAgentHookInput,
  context: ProcessTerminalAgentHookContext = {},
): Promise<ProcessTerminalAgentHookResult> {
  let session = options.terminalSessionManager.getSession(
    input.terminalSessionId,
  );
  if (!session) {
    return {
      status: "not_found",
      terminalSessionId: input.terminalSessionId,
    };
  }
  if (session.status === "exited") {
    return {
      status: "exited",
      terminalSessionId: session.id,
      terminalState: options.terminalStateService.getCurrent(
        session.id,
        session,
      ),
    };
  }

  const panelResolution = resolveHookPanel(
    options.terminalSessionManager,
    session.id,
    input.panelId ?? null,
    input.tmuxPaneId ?? null,
  );
  if (!panelResolution.ok) {
    return {
      status: "ignored",
      terminalSessionId: session.id,
      agent: input.agent,
      hookEvent: input.hookEvent,
      activeCommand: session.activeCommand,
      terminalState: options.terminalStateService.getCurrent(
        session.id,
        session,
      ),
      panelId: null,
      ignoreReason: "panel_identity_mismatch",
    };
  }
  const panel = panelResolution.panel;
  const hookThreadId = input.threadId?.trim() || null;
  const currentThreadOwner = panel ?? session;
  const lastThreadOwner =
    panel?.lastThreadId || panel?.lastThreadProvider ? panel : session;
  const persistedLastThreadProvider =
    lastThreadOwner.lastThreadProvider ??
    (lastThreadOwner.lastThreadId ? "codex" : null);
  const resumedLastThreadIdentityMatched = Boolean(
    input.hookEvent === "UserPromptSubmit" &&
    hookThreadId &&
    !currentThreadOwner.threadId &&
    !currentThreadOwner.threadProvider &&
    lastThreadOwner.lastThreadId === hookThreadId &&
    persistedLastThreadProvider === input.agent,
  );
  const operationGenerationTracked = Boolean(
    panel
      ? options.terminalSessionManager.hasPanelAgentOperationGeneration(
          session.id,
          panel.id,
        )
      : options.terminalSessionManager.hasSessionAgentPreparation(session.id),
  );
  const operationIdentityMatched = Boolean(
    panel &&
    input.operationId &&
    options.terminalSessionManager.matchesPanelAgentOperationGeneration(
      session.id,
      panel.id,
      input.operationId,
      input.agent,
    ),
  );
  const trustedCurrentThreadIdentityMatched = Boolean(
    context.currentThreadIdentityMatched || resumedLastThreadIdentityMatched,
  );
  if (
    operationGenerationTracked &&
    !operationIdentityMatched &&
    !trustedCurrentThreadIdentityMatched
  ) {
    return {
      status: "ignored",
      terminalSessionId: session.id,
      agent: input.agent,
      hookEvent: input.hookEvent,
      activeCommand: session.activeCommand,
      terminalState:
        panel?.terminalState ??
        session.terminalState ??
        ({ state: "shell_idle", agent: null } satisfies TerminalState),
      panelId: panel?.id ?? null,
      ignoreReason: "operation_identity_mismatch",
    };
  }
  const currentThreadIdentityMatched =
    operationIdentityMatched || trustedCurrentThreadIdentityMatched;

  const sessionAgent = getTerminalSessionAgent(session);
  const panelAgent = panel ? getTerminalSessionAgent(panel) : null;
  const activeAgent = panel ? panelAgent : sessionAgent;
  const threadOwner =
    panel?.threadId || panel?.threadProvider ? panel : session;
  const currentThreadProvider =
    threadOwner.threadProvider ?? (threadOwner.threadId ? "codex" : null);
  const expectedProvider = activeAgent ?? currentThreadProvider;
  if (
    !currentThreadIdentityMatched &&
    expectedProvider &&
    !isCompletionSourceAllowedForCommand(input.agent, expectedProvider)
  ) {
    return {
      status: "ignored",
      terminalSessionId: session.id,
      agent: input.agent,
      hookEvent: input.hookEvent,
      activeCommand: session.activeCommand,
      terminalState: options.terminalStateService.getCurrent(
        session.id,
        session,
      ),
      panelId: panel?.id ?? null,
      ignoreReason: "agent_identity_mismatch",
    };
  }
  const effectiveAgent = currentThreadIdentityMatched
    ? input.agent
    : panel &&
        panelAgent &&
        isCompletionSourceAllowedForCommand(input.agent, panel.activeCommand)
      ? panelAgent
      : sessionAgent &&
          isCompletionSourceAllowedForCommand(
            input.agent,
            session.activeCommand,
          )
        ? sessionAgent
        : input.agent;
  const targetActiveCommand = panel?.activeCommand ?? session.activeCommand;
  const recentAgentActivity =
    options.terminalSessionManager.getRecentAgentActivity(
      session.id,
      panel?.id ?? null,
    );
  const targetCommandSource = getCompletionSourceForCommand(
    targetActiveCommand,
  );
  const reportedCommandMatchesCurrentTarget =
    targetCommandSource === input.agent &&
    targetCommandSource ===
      getCompletionSourceForCommand(input.commandName ?? null);
  const currentCommandMatches =
    isCompletionSourceAllowedForCommand(input.agent, targetActiveCommand) ||
    reportedCommandMatchesCurrentTarget ||
    sessionAgent === effectiveAgent ||
    panelAgent === effectiveAgent;
  const graceCommandMatches =
    input.hookEvent === "Stop" &&
    targetActiveCommand === null &&
    recentAgentActivity?.phase === "grace" &&
    recentAgentActivity.source === input.agent &&
    recentAgentActivity.clearedAt !== null &&
    (recentAgentActivity.operationId === null
      ? !operationGenerationTracked
      : recentAgentActivity.operationId === input.operationId) &&
    Date.now() - recentAgentActivity.clearedAt <=
      AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS;
  const currentTargetState =
    panel?.terminalState ??
    options.terminalStateService.getCurrent(session.id, session);
  const canFallbackToCurrentStateAgent =
    input.hookEvent !== "Stop" && currentTargetState.agent === effectiveAgent;

  if (
    input.hookEvent !== "SessionStart" &&
    !currentThreadIdentityMatched &&
    !currentCommandMatches &&
    !graceCommandMatches &&
    !canFallbackToCurrentStateAgent
  ) {
    return {
      status: "ignored",
      terminalSessionId: session.id,
      agent: effectiveAgent,
      hookEvent: input.hookEvent,
      activeCommand: session.activeCommand,
      terminalState: currentTargetState,
      panelId: panel?.id ?? null,
      ignoreReason: "inactive_agent",
    };
  }

  let terminalState: TerminalState;
  if (panel) {
    const panelTerminalState = resolveAgentHookTerminalState(
      effectiveAgent,
      input.hookEvent,
    );
    await options.terminalSessionManager.updatePanelTerminalState(
      panel.id,
      panelTerminalState,
      input.operationId,
    );
    terminalState = aggregatePanelTerminalState(
      options.terminalSessionManager.listPanels(session.id),
    );
    options.terminalStateService.setAggregatedPanelAgentHookState(
      session.id,
      terminalState,
      session.projectId,
    );
  } else {
    terminalState = options.terminalStateService.handleAgentHook(
      session.id,
      effectiveAgent,
      input.hookEvent,
      {
        projectId: session.projectId,
        reason: "agent_hook",
      },
    );
  }
  if (hookThreadId) {
    session =
      (await syncAgentThreadMetadata({
        terminalSessionManager: options.terminalSessionManager,
        session,
        panel,
        provider: effectiveAgent,
        hookEvent: input.hookEvent,
        threadId: hookThreadId,
        operationId: input.operationId,
      })) ?? session;
  }
  return {
    status: "recorded",
    terminalSessionId: session.id,
    agent: effectiveAgent,
    hookEvent: input.hookEvent,
    terminalState,
    panelId: panel?.id ?? null,
  };
}

export async function syncAgentThreadMetadata(options: {
  terminalSessionManager: TerminalSessionManager;
  session: ReturnType<TerminalSessionManager["getSession"]>;
  panel: ReturnType<TerminalSessionManager["getPanel"]> | null;
  provider: TerminalAgentKind;
  hookEvent: AgentHookStateEvent;
  threadId: string;
  operationId?: string | null;
}): Promise<ReturnType<TerminalSessionManager["getSession"]>> {
  const session = options.session;
  if (!session) {
    return session;
  }

  const lastThreadUpdatedAt = new Date();
  const lastThreadStatus = getLastThreadStatusForHookEvent(options.hookEvent);
  await options.terminalSessionManager.updateSessionLastThread(
    session.id,
    options.threadId,
    lastThreadStatus,
    lastThreadUpdatedAt,
    options.provider,
  );
  if (options.panel) {
    await options.terminalSessionManager.updatePanelLastThread(
      options.panel.id,
      options.threadId,
      lastThreadStatus,
      lastThreadUpdatedAt,
      options.provider,
      options.operationId,
    );
  }

  if (
    options.hookEvent === "SessionStart" ||
    options.hookEvent === "UserPromptSubmit"
  ) {
    const runningPanelCount = options.terminalSessionManager
      .listPanels(session.id)
      .filter((candidate) => candidate.status === "running").length;
    const shouldWriteSessionMetadata = runningPanelCount <= 1;
    const previousThreadId = session.threadId;
    const previousPanelThreadId = options.panel?.threadId;
    let nextSession = session;

    if (shouldWriteSessionMetadata) {
      nextSession =
        (await options.terminalSessionManager.updateSessionThreadId(
          session.id,
          options.threadId,
          options.provider,
        )) ?? nextSession;
      if (previousThreadId !== options.threadId) {
        await options.terminalSessionManager.updateSessionPreview(
          session.id,
          null,
        );
      }
    }
    if (options.hookEvent === "SessionStart" && options.provider === "codex") {
      updateCodexThreadPreviewInBackground(
        options.terminalSessionManager,
        session.id,
        options.threadId,
        options.panel?.id ?? null,
        shouldWriteSessionMetadata,
      );
    }
    if (options.panel) {
      await options.terminalSessionManager.updatePanelThreadId(
        options.panel.id,
        options.threadId,
        options.provider,
        options.operationId,
      );
      if (previousPanelThreadId !== options.threadId) {
        await options.terminalSessionManager.updatePanelPreview(
          options.panel.id,
          null,
        );
      }
    }
    return nextSession;
  }

  if (options.hookEvent !== "Stop") {
    return session;
  }

  const runningPanelCount = options.terminalSessionManager
    .listPanels(session.id)
    .filter((candidate) => candidate.status === "running").length;
  let nextSession = session;
  if (
    session.threadId === options.threadId &&
    (runningPanelCount <= 1 || !options.panel)
  ) {
    nextSession =
      (await options.terminalSessionManager.updateSessionThreadId(
        session.id,
        null,
      )) ?? nextSession;
    await options.terminalSessionManager.updateSessionPreview(session.id, null);
  }
  if (options.panel?.threadId === options.threadId) {
    await options.terminalSessionManager.updatePanelThreadId(
      options.panel.id,
      null,
      null,
      options.operationId,
    );
    await options.terminalSessionManager.updatePanelPreview(
      options.panel.id,
      null,
    );
  }
  return nextSession;
}

function updateCodexThreadPreviewInBackground(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
  threadId: string,
  panelId: string | null,
  updateSessionPreview: boolean,
): void {
  void readCodexThreadSnapshot(threadId)
    .then(async ({ preview }) => {
      if (updateSessionPreview) {
        await terminalSessionManager.updateSessionPreview(
          terminalSessionId,
          preview,
        );
      }
      if (panelId) {
        await terminalSessionManager.updatePanelPreview(panelId, preview);
      }
    })
    .catch((error) => {
      agentHookProcessorLogger.warn("terminal-agent-hook.preview.failed", {
        message: "Failed to load Codex thread preview",
        terminalSessionId,
        threadId,
        error,
      });
    });
}

function resolveHookPanel(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
  panelId: string | null,
  tmuxPaneId: string | null,
):
  | {
      ok: true;
      panel: ReturnType<TerminalSessionManager["getPanel"]> | null;
    }
  | { ok: false } {
  const byId = panelId
    ? (terminalSessionManager.getPanel(panelId) ?? null)
    : null;
  const panels = tmuxPaneId
    ? terminalSessionManager.listPanels(terminalSessionId)
    : [];
  const paneMatches = tmuxPaneId
    ? panels.filter((panel) => panel.tmuxPaneId === tmuxPaneId)
    : [];
  const byPane = paneMatches.length === 1 ? paneMatches[0] : null;

  if (panelId) {
    if (
      byId?.terminalSessionId === terminalSessionId &&
      (!tmuxPaneId || byId.tmuxPaneId === tmuxPaneId)
    ) {
      return { ok: true, panel: byId };
    }
    return tmuxPaneId && byPane ? { ok: true, panel: byPane } : { ok: false };
  }
  if (tmuxPaneId) {
    return byPane ? { ok: true, panel: byPane } : { ok: false };
  }
  const runningPanels = terminalSessionManager
    .listPanels(terminalSessionId)
    .filter((panel) => panel.status === "running");
  if (runningPanels.length === 1) {
    return { ok: true, panel: runningPanels[0]! };
  }
  return runningPanels.length === 0
    ? { ok: true, panel: null }
    : { ok: false };
}
