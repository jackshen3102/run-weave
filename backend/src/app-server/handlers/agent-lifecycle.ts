import type { AppServerEventEnvelope } from "@runweave/shared/app-server-events";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import type { TerminalActivityDependencies } from "../../terminal/activity-events";
import { processTerminalAgentHook } from "../../terminal/agent-hook-processor";
import type { TerminalSessionManager } from "../../terminal/manager";
import type { TerminalStateService } from "../../terminal/terminal-state-service";
import { readAppServerPayloadString } from "./agent-event-payload";

const TERMINAL_AGENTS = new Set<TerminalAgentKind>([
  "codex",
  "trae",
  "traecli",
  "traex",
]);

export async function handleAgentLifecycleEvent(
  event: AppServerEventEnvelope,
  options: {
    terminalSessionManager: TerminalSessionManager;
    terminalStateService: TerminalStateService;
    activity?: TerminalActivityDependencies;
  },
): Promise<void> {
  const terminalSessionId = event.scope?.terminalSessionId;
  const threadId = event.correlationId?.trim();
  const provider = readProvider(event.payload);
  const observedStatus = readAppServerPayloadString(
    event.payload,
    "observedStatus",
  );
  if (
    !terminalSessionId ||
    !threadId ||
    !provider ||
    (observedStatus !== "idle" && observedStatus !== "running")
  ) {
    return;
  }
  const session = options.terminalSessionManager.getSession(terminalSessionId);
  if (!session) {
    return;
  }
  const panel = resolvePanel(event, options.terminalSessionManager);
  const owner = panel?.threadId || panel?.threadProvider ? panel : session;
  const currentThreadId = owner.threadId?.trim() || null;
  const currentProvider =
    owner.threadProvider ?? (currentThreadId ? "codex" : null);
  const shouldUpdateForeground =
    (!currentThreadId || currentThreadId === threadId) &&
    (!currentProvider || currentProvider === provider);
  const currentThreadIdentityMatched =
    currentThreadId === threadId && currentProvider === provider;
  const foregroundResult = shouldUpdateForeground
    ? await processTerminalAgentHook(options, {
        terminalSessionId: session.id,
        agent: provider,
        hookEvent: observedStatus === "running" ? "UserPromptSubmit" : "Stop",
        threadId,
        panelId: event.scope?.terminalPanelId,
        tmuxPaneId: event.scope?.terminalTmuxPaneId,
        currentThreadIdentityMatched,
      })
    : null;

  const preview = readAppServerPayloadString(event.payload, "preview");
  if (foregroundResult?.status === "recorded" && preview) {
    if (
      !panel ||
      options.terminalSessionManager.listPanels(session.id).length <= 1
    ) {
      await options.terminalSessionManager.updateSessionPreview(
        session.id,
        preview,
      );
    }
    if (panel) {
      await options.terminalSessionManager.updatePanelPreview(
        panel.id,
        preview,
      );
    }
  }

  options.activity?.recorder.record(
    options.activity.eventFactory.create({
      eventName: "agent.lifecycle.observed",
      occurredAt: event.createdAt,
      actorType: "agent",
      actorAgent: provider === "codex" ? "codex" : "trae",
      scope: {
        projectId: session.projectId,
        terminalSessionId: session.id,
        panelId: panel?.id,
        tmuxPaneId: event.scope?.terminalTmuxPaneId ?? undefined,
        threadId,
        turnId:
          readAppServerPayloadString(event.payload, "turnId") ?? undefined,
      },
      correlationId: threadId,
      payload: {
        provider,
        observedStatus,
        observedLifecycle:
          readAppServerPayloadString(event.payload, "observedLifecycle") ??
          "unknown",
        detailStatus:
          readAppServerPayloadString(event.payload, "detailStatus") ??
          observedStatus,
        lifecycleCursor:
          readAppServerPayloadString(event.payload, "lifecycleCursor") ??
          "unknown",
        compensation:
          readBoolean(event.payload, "compensation") ?? false,
        compensationReason:
          readAppServerPayloadString(event.payload, "compensationReason") ??
          null,
      },
    }),
  );
}

function resolvePanel(
  event: AppServerEventEnvelope,
  terminalSessionManager: TerminalSessionManager,
) {
  const panelId = event.scope?.terminalPanelId;
  const terminalSessionId = event.scope?.terminalSessionId;
  if (panelId) {
    const panel = terminalSessionManager.getPanel(panelId);
    return panel?.terminalSessionId === terminalSessionId ? panel : null;
  }
  const tmuxPaneId = event.scope?.terminalTmuxPaneId;
  return tmuxPaneId && terminalSessionId
    ? terminalSessionManager
        .listPanels(terminalSessionId)
        .find((panel) => panel.tmuxPaneId === tmuxPaneId) ?? null
    : null;
}

function readProvider(payload: unknown): TerminalAgentKind | null {
  const provider = readAppServerPayloadString(payload, "source");
  return provider && TERMINAL_AGENTS.has(provider as TerminalAgentKind)
    ? (provider as TerminalAgentKind)
    : null;
}

function readBoolean(payload: unknown, key: string): boolean | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}
