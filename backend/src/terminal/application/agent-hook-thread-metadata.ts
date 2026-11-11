import type { AgentHookStateEvent } from "@runweave/shared/terminal/events";
import type { TerminalLastThreadStatus } from "@runweave/shared/terminal/session";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import type { TerminalSessionManager } from "../manager/manager";
import { readCodexThreadSnapshot } from "../runtime/codex-thread-snapshot";
import { logger } from "../../logging/index";

const agentHookProcessorLogger = logger.child({ component: "terminal-agent-hook" });

function getLastThreadStatusForHookEvent(
  hookEvent: AgentHookStateEvent,
): TerminalLastThreadStatus {
  return hookEvent === "UserPromptSubmit" ? "running" : "idle";
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
