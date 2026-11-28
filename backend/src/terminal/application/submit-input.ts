import type {
  SendTerminalInputRequest,
  TerminalInputMode,
} from "@runweave/shared/terminal/input";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import type { TerminalEventService } from "../state/terminal-event-service";
import type { TerminalQuickInputService } from "../quick-input/service";
import { sendInputToSession } from "./input-dispatcher";
import { isTmuxBackedSession } from "../runtime/launcher";
import { readCodexContext } from "../runtime/codex-context";
import { resolvePanelTarget } from "./panel-targets";
import { getTerminalSessionAgent } from "../state/terminal-state-service";
import { logger } from "../../logging/index";
const terminalLogger = logger.child({ component: "terminal" });

type ConversationClearCandidate = {
  panelId: string | null;
  threadId: string | null;
  provider: TerminalAgentKind | null;
};

function isConversationClearCommand(
  agent: TerminalAgentKind,
  command: string,
): boolean {
  // Claude (/clear) and Pi (/new) emit authoritative SessionStart hooks immediately;
  // only agents that defer SessionStart until the next prompt clear optimistically.
  if (agent === "claude" || agent === "pi") return false;
  return command === "/clear" || command === "/new";
}

function hasBlockingAgentPrompt(
  owner: TerminalPanelRecord | TerminalSessionRecord,
  panel: TerminalPanelRecord | null,
): boolean {
  const oscState = owner.oscProgramStatus?.state;
  if (oscState === "blocked" || oscState === "working" || oscState === "starting") {
    return true;
  }
  if (panel?.pendingPermissionRequest || panel?.pendingAgyQuestion) {
    return true;
  }
  if (owner.pi?.event === "ui_prompt_start") {
    return true;
  }
  return false;
}

function readOwnerThreadIdentity(
  owner: TerminalPanelRecord | TerminalSessionRecord | undefined,
): { threadId: string | null; provider: TerminalAgentKind | null } {
  if (!owner) return { threadId: null, provider: null };
  if (owner.threadId) {
    return {
      threadId: owner.threadId,
      provider: owner.threadProvider ?? "codex",
    };
  }
  if (owner.lastThreadId) {
    return {
      threadId: owner.lastThreadId,
      provider: owner.lastThreadProvider ?? "codex",
    };
  }
  return { threadId: null, provider: null };
}

function resolveConversationClearCandidate(params: {
  session: TerminalSessionRecord;
  panel: TerminalPanelRecord | null;
  input: SendTerminalInputRequest;
  mode: TerminalInputMode | undefined;
  options: TerminalSubmissionOptions;
}): ConversationClearCandidate | null {
  const { session, panel, input, mode, options } = params;
  const submitted =
    mode === "line" ||
    mode === "codex_slash_command" ||
    mode === "prompt_paste" ||
    (mode === "prompt_replace" && input.submit === true);
  if (!submitted || (input.submitKey && input.submitKey !== "Enter")) {
    return null;
  }
  const command = input.data.trim();
  if (!command || command.includes("\n") || command.includes("\r")) {
    return null;
  }
  const owner = panel ?? session;
  const agent = getTerminalSessionAgent(owner);
  if (!agent || !isConversationClearCommand(agent, command)) {
    return null;
  }
  // Managed Codex publishes its primary thread natively in codex-context.
  if (agent === "codex" && panel && readCodexContext(panel).managed) {
    return null;
  }
  const ownerState = panel
    ? panel.terminalState
    : (options.terminalStateService?.getCurrent(session.id, session) ??
      session.terminalState);
  if (ownerState?.state !== "agent_idle" || hasBlockingAgentPrompt(owner, panel)) {
    return null;
  }
  const identity = readOwnerThreadIdentity(owner);
  if (!identity.threadId && !owner.preview && !owner.latestReply) {
    return null;
  }
  return {
    panelId: panel?.id ?? null,
    threadId: identity.threadId,
    provider: identity.provider,
  };
}

export class TerminalInputSubmissionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type TerminalSubmissionOptions = NonNullable<
  Parameters<typeof sendInputToSession>[1]
> & {
  terminalEventService?: TerminalEventService;
  quickInputService?: TerminalQuickInputService;
};
export async function submitTerminalInput(
  terminalSessionManager: TerminalSessionManager,
  options: TerminalSubmissionOptions,
  session: TerminalSessionRecord,
  input: SendTerminalInputRequest,
  beforeDispatch?: () => void,
) {
  const inputMode = input.mode as TerminalInputMode | undefined;
  const panelTarget =
    isTmuxBackedSession(session) && options.tmuxService
      ? await resolvePanelTarget(
          terminalSessionManager,
          session,
          {
            tmuxService: options.tmuxService,
            terminalEventService: options.terminalEventService,
          },
          {
            panelId: input.panelId,
            panelAlias: input.panelAlias,
            role: input.role,
          },
          "explicit-or-active",
        )
      : undefined;
  const targetPanel =
    panelTarget?.panel ??
    (isTmuxBackedSession(session)
      ? (() => {
          const activeId =
            input.panelId ??
            terminalSessionManager.getPanelWorkspace(session.id)?.activePanelId;
          return activeId
            ? (terminalSessionManager.getPanel(activeId) ?? null)
            : null;
        })()
      : null);
  if (
    input.quickInputSource === "web_browser_annotation" &&
    !getTerminalSessionAgent(targetPanel ?? session)
  ) {
    throw new TerminalInputSubmissionError(
      409,
      "Browser comments require an active Agent terminal",
    );
  }
  const clearCandidate = resolveConversationClearCandidate({
    session,
    panel: targetPanel,
    input,
    mode: inputMode,
    options,
  });
  beforeDispatch?.();
  if (input.operationId) terminalLogger.info("terminal.input.requested", { operationId: input.operationId, terminalSessionId: session.id });
  const payload = await sendInputToSession(
    terminalSessionManager,
    { ...options, codexInputContext: input.codexInputContext },
    session,
    input.data,
    inputMode,
    input.operationId,
    panelTarget?.paneTarget,
    input.submit,
    input.submitKey,
    input.expectedThreadId,
  );
  if (input.operationId && payload.inputAccepted) terminalLogger.info("terminal.input.accepted", { operationId: input.operationId, terminalSessionId: session.id });
  if (payload.inputAccepted && clearCandidate) {
    const currentOwner = clearCandidate.panelId
      ? terminalSessionManager.getPanel(clearCandidate.panelId)
      : terminalSessionManager.getSession(session.id);
    const currentIdentity = readOwnerThreadIdentity(currentOwner);
    if (
      currentOwner &&
      currentIdentity.threadId === clearCandidate.threadId &&
      currentIdentity.provider === clearCandidate.provider
    ) {
      await terminalSessionManager.clearConversation(
        session.id,
        clearCandidate.panelId,
      );
    }
  }
  if (
    options.quickInputService &&
    payload.inputAccepted &&
    input.recordQuickInput !== false
  ) {
    try {
      await options.quickInputService.recordRecentInput({
        data: input.data,
        mode: inputMode,
        projectId: session.projectId,
        terminalSessionId: session.id,
        cwd: session.cwd,
        source: input.quickInputSource ?? "api_terminal_input",
        acceptedAt: payload.acceptedAt,
      });
    } catch (error) {
      terminalLogger.warn("terminal.quick-input.record.failed", {
        message: "Terminal quick input record failed",
        terminalSessionId: session.id,
        projectId: session.projectId,
        inputMode: inputMode ?? "raw",
        error,
      });
    }
  }
  return payload;
}
