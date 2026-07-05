import type {
  AgentHookStateEvent,
  TerminalAgentKind,
  TerminalState,
} from "@runweave/shared";
import { logger } from "../logging";
import {
  AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS,
  isCompletionSourceAllowedForCommand,
} from "./completion-source-gate";
import type { TerminalSessionManager } from "./manager";
import {
  getTerminalSessionAgent,
  type TerminalStateService,
} from "./terminal-state-service";
import { readCodexThreadSnapshot } from "./codex-thread-snapshot";

const agentHookProcessorLogger = logger.child({
  component: "terminal-agent-hook",
});

export interface ProcessTerminalAgentHookInput {
  terminalSessionId: string;
  agent: TerminalAgentKind;
  hookEvent: AgentHookStateEvent;
  threadId?: string | null;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  commandName?: string | null;
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
    };
  }
  const panel = panelResolution.panel;

  if (input.agent === "codex" && input.threadId) {
    const runningPanelCount = options.terminalSessionManager
      .listPanels(session.id)
      .filter((candidate) => candidate.status === "running").length;
    const shouldWriteSessionMetadata = runningPanelCount <= 1;
    const previousThreadId = session.threadId;
    const previousPanelThreadId = panel?.threadId;
    if (shouldWriteSessionMetadata) {
      session =
        (await options.terminalSessionManager.updateSessionThreadId(
          session.id,
          input.threadId,
        )) ?? session;
      if (
        input.hookEvent === "SessionStart" &&
        previousThreadId !== input.threadId
      ) {
        await options.terminalSessionManager.updateSessionPreview(
          session.id,
          null,
        );
      }
    }
    if (input.hookEvent === "SessionStart") {
      updateCodexThreadPreviewInBackground(
        options.terminalSessionManager,
        session.id,
        input.threadId,
        panel?.id ?? null,
        shouldWriteSessionMetadata,
      );
    }
    if (panel) {
      await options.terminalSessionManager.updatePanelThreadId(
        panel.id,
        input.threadId,
      );
      if (
        input.hookEvent === "SessionStart" &&
        previousPanelThreadId !== input.threadId
      ) {
        await options.terminalSessionManager.updatePanelPreview(panel.id, null);
      }
    }
  }

  const sessionAgent = getTerminalSessionAgent(session);
  const panelAgent = panel ? getTerminalSessionAgent(panel) : null;
  const effectiveAgent =
    panel &&
    panelAgent &&
    (isCompletionSourceAllowedForCommand(input.agent, panel.activeCommand) ||
      isCompletionSourceAllowedForCommand(input.agent, input.commandName ?? null))
      ? panelAgent
      : sessionAgent &&
          (isCompletionSourceAllowedForCommand(
            input.agent,
            session.activeCommand,
          ) ||
            isCompletionSourceAllowedForCommand(
              input.agent,
              input.commandName ?? null,
            ))
        ? sessionAgent
        : input.agent;
  const lastAiActiveCommand =
    options.terminalSessionManager.getLastAiActiveCommand(session.id);
  const currentCommandMatches =
    isCompletionSourceAllowedForCommand(input.agent, session.activeCommand) ||
    (panel
      ? isCompletionSourceAllowedForCommand(input.agent, panel.activeCommand)
      : false) ||
    isCompletionSourceAllowedForCommand(input.agent, input.commandName ?? null) ||
    sessionAgent === effectiveAgent ||
    panelAgent === effectiveAgent;
  const graceCommandMatches =
    session.activeCommand === null &&
    lastAiActiveCommand !== null &&
    lastAiActiveCommand.source === input.agent &&
    lastAiActiveCommand.clearedAt !== null &&
    Date.now() - lastAiActiveCommand.clearedAt <=
      AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS;

  if (
    input.hookEvent !== "SessionStart" &&
    !currentCommandMatches &&
    !graceCommandMatches &&
    options.terminalStateService.getCurrent(session.id, session).agent !==
      effectiveAgent
  ) {
    return {
      status: "ignored",
      terminalSessionId: session.id,
      agent: effectiveAgent,
      hookEvent: input.hookEvent,
      activeCommand: session.activeCommand,
      terminalState: options.terminalStateService.getCurrent(
        session.id,
        session,
      ),
      panelId: panel?.id ?? null,
    };
  }

  const terminalState = options.terminalStateService.handleAgentHook(
    session.id,
    effectiveAgent,
    input.hookEvent,
    {
      projectId: session.projectId,
      reason: "agent_hook",
    },
  );
  if (panel) {
    await options.terminalSessionManager.updatePanelTerminalState(
      panel.id,
      terminalState,
    );
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
    ? terminalSessionManager.getPanel(panelId) ?? null
    : null;
  const panels = tmuxPaneId
    ? terminalSessionManager.listPanels(terminalSessionId)
    : [];
  const byPane = tmuxPaneId
    ? panels.find((panel) => panel.tmuxPaneId === tmuxPaneId) ?? null
    : null;

  if (panelId) {
    if (
      !byId ||
      byId.terminalSessionId !== terminalSessionId ||
      (tmuxPaneId && byId.tmuxPaneId !== tmuxPaneId)
    ) {
      return { ok: false };
    }
    return { ok: true, panel: byId };
  }
  if (tmuxPaneId) {
    return { ok: true, panel: byPane };
  }
  return { ok: true, panel: null };
}
