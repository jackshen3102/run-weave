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
    }
  | {
      status: "recorded";
      terminalSessionId: string;
      agent: TerminalAgentKind;
      hookEvent: AgentHookStateEvent;
      terminalState: TerminalState;
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

  if (input.agent === "codex" && input.threadId) {
    const previousThreadId = session.threadId;
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
    if (input.hookEvent === "SessionStart") {
      updateCodexThreadPreviewInBackground(
        options.terminalSessionManager,
        session.id,
        input.threadId,
      );
    }
  }

  const sessionAgent = getTerminalSessionAgent(session);
  const effectiveAgent =
    sessionAgent &&
    isCompletionSourceAllowedForCommand(input.agent, session.activeCommand)
      ? sessionAgent
      : input.agent;
  const lastAiActiveCommand =
    options.terminalSessionManager.getLastAiActiveCommand(session.id);
  const currentCommandMatches =
    isCompletionSourceAllowedForCommand(input.agent, session.activeCommand) ||
    sessionAgent === effectiveAgent;
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
  return {
    status: "recorded",
    terminalSessionId: session.id,
    agent: effectiveAgent,
    hookEvent: input.hookEvent,
    terminalState,
  };
}

function updateCodexThreadPreviewInBackground(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
  threadId: string,
): void {
  void readCodexThreadSnapshot(threadId)
    .then(async ({ preview }) => {
      await terminalSessionManager.updateSessionPreview(
        terminalSessionId,
        preview,
      );
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
