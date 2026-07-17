import { randomUUID } from "node:crypto";
import type { TerminalState } from "@runweave/shared/terminal-protocol";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager";
import type { TmuxPaneInfo } from "../tmux-service";
import type { TerminalEventService } from "../terminal-event-service";
import { getExecutableCommandName } from "../completion-source-gate";
import {
  aggregatePanelTerminalState,
  getAgentForCommand,
} from "../terminal-state-service";
import { toPanelWorkspacePayload } from "./payloads";

export function buildDefaultPanel(
  session: TerminalSessionRecord,
  pane: TmuxPaneInfo,
): TerminalPanelRecord {
  const now = new Date();
  const activeCommand = resolveEffectivePanelActiveCommand(
    pane,
    session.activeCommand,
  );
  const terminalState = getPanelTerminalStateForActiveCommand(activeCommand);
  const sessionMetadata = getSessionAgentMetadataForMainPanel(
    session,
    terminalState,
  );
  return {
    id: randomUUID(),
    terminalSessionId: session.id,
    alias: "main",
    role: "main",
    ...sessionMetadata,
    agentTeamRunId: null,
    agentTeamWorkerId: null,
    cwd: pane.cwd || session.cwd,
    activeCommand,
    terminalState: sessionMetadata.terminalState ?? terminalState,
    status: "running",
    createdAt: now,
    lastActivityAt: now,
    runtimeKind: "tmux",
    tmuxPaneId: pane.paneId,
  };
}

export function buildSplitPanel(
  session: TerminalSessionRecord,
  paneId: string,
  params: {
    panelId: string;
    alias: string | null;
    role: string | null;
    agentTeamRunId: string | null;
    agentTeamWorkerId: string | null;
    cwd: string;
    activeCommand: string | null;
  },
): TerminalPanelRecord {
  const now = new Date();
  return {
    id: params.panelId,
    terminalSessionId: session.id,
    alias: params.alias,
    role: params.role,
    agentTeamRunId: params.agentTeamRunId,
    agentTeamWorkerId: params.agentTeamWorkerId,
    cwd: params.cwd,
    activeCommand: params.activeCommand,
    terminalState: getPanelTerminalStateForActiveCommand(params.activeCommand),
    status: "running",
    createdAt: now,
    lastActivityAt: now,
    runtimeKind: "tmux",
    tmuxPaneId: paneId,
  };
}

export function getPanelTerminalStateForActiveCommand(
  activeCommand: string | null,
  previous?: TerminalState,
): TerminalState {
  const agent = getAgentForCommand(activeCommand);
  if (!agent) {
    return { state: "shell_idle", agent: null };
  }
  if (previous?.agent === agent) {
    return previous;
  }
  return { state: "agent_starting", agent };
}

export function resolveReconciledPanelTerminalState(
  pane: Pick<
    TmuxPaneInfo,
    | "activeCommand"
    | "activeCommandSource"
    | "agentPrepareCommand"
    | "agentPrepareExit"
    | "paneCommand"
  >,
  effectiveActiveCommand: string | null,
  previous?: TerminalState,
): TerminalState {
  const next = getPanelTerminalStateForActiveCommand(
    effectiveActiveCommand,
    previous,
  );
  if (
    resolvePendingPreparedAgent(pane) &&
    previous?.agent &&
    !getAgentForCommand(effectiveActiveCommand)
  ) {
    return previous;
  }
  return next;
}

function getSessionAgentForPanelBackfill(
  session: TerminalSessionRecord,
): string | null {
  return (
    session.terminalState?.agent ?? getAgentForCommand(session.activeCommand)
  );
}

function getSessionAgentMetadataForMainPanel(
  session: TerminalSessionRecord,
  panelTerminalState: TerminalState,
): Pick<
  TerminalPanelRecord,
  "threadId" | "threadProvider" | "preview" | "terminalState"
> {
  const sessionAgent = getSessionAgentForPanelBackfill(session);
  if (
    !sessionAgent ||
    panelTerminalState.agent !== sessionAgent ||
    (!session.threadId && !session.preview)
  ) {
    return {};
  }
  return {
    ...(session.threadId ? { threadId: session.threadId } : {}),
    ...(session.threadProvider
      ? { threadProvider: session.threadProvider }
      : {}),
    ...(session.preview ? { preview: session.preview } : {}),
    ...(session.terminalState ? { terminalState: session.terminalState } : {}),
  };
}

function isMainPanel(panel: TerminalPanelRecord): boolean {
  return panel.alias === "main" || panel.role === "main";
}

function isPrimaryPanel(
  panel: TerminalPanelRecord,
  panels: TerminalPanelRecord[],
): boolean {
  if (isMainPanel(panel)) {
    return true;
  }
  const runningPanels = panels.filter(
    (candidate) => candidate.status === "running",
  );
  return (
    runningPanels.length === 1 &&
    runningPanels[0]?.id === panel.id &&
    !runningPanels.some(isMainPanel)
  );
}

export function shouldBackfillSessionAgentMetadataToMainPanel(
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord,
  nextTerminalState: TerminalState,
  panels: TerminalPanelRecord[],
): boolean {
  if (!isPrimaryPanel(panel, panels) || panel.threadId || panel.preview) {
    return false;
  }
  const sessionAgent = getSessionAgentForPanelBackfill(session);
  if (
    !sessionAgent ||
    nextTerminalState.agent !== sessionAgent ||
    (!session.threadId && !session.preview)
  ) {
    return false;
  }
  return !panels.some(
    (candidate) =>
      candidate.id !== panel.id &&
      candidate.status === "running" &&
      ((session.threadId && candidate.threadId === session.threadId) ||
        (session.preview && candidate.preview === session.preview)),
  );
}

export function isEnvironmentAssignmentOnlyActiveCommand(
  activeCommand: string | null,
): boolean {
  const normalized = activeCommand?.trim();
  return Boolean(
    normalized &&
    /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(normalized) &&
    !getExecutableCommandName(normalized),
  );
}

function getCommandBasename(activeCommand: string | null): string | null {
  const normalized = activeCommand?.trim();
  if (!normalized) {
    return null;
  }
  return normalized.split(/[\\/]/).at(-1) ?? normalized;
}

const NODE_WRAPPED_ACTIVE_COMMANDS = new Set([
  "codex",
  "npm",
  "npx",
  "pnpm",
  "trae",
  "traecli",
  "traex",
  "yarn",
]);

function isInteractiveShellActiveCommand(
  activeCommand: string | null,
): boolean {
  const basename = getCommandBasename(activeCommand);
  return Boolean(basename && ["bash", "zsh", "sh", "fish"].includes(basename));
}

function shouldKeepNodeWrappedActiveCommand(
  existingActiveCommand: string | null,
  pane: TmuxPaneInfo,
): boolean {
  return (
    pane.activeCommandSource === "pane_current_command" &&
    getCommandBasename(pane.activeCommand) === "node" &&
    NODE_WRAPPED_ACTIVE_COMMANDS.has(
      getCommandBasename(existingActiveCommand) ?? "",
    )
  );
}

function terminalStatesEqual(
  left: TerminalState | undefined,
  right: TerminalState | undefined,
): boolean {
  return left?.state === right?.state && left?.agent === right?.agent;
}

export function resolveEffectivePanelActiveCommand(
  pane: TmuxPaneInfo,
  existingActiveCommand?: string | null,
): string | null {
  const preparedAgent = resolvePendingPreparedAgent(pane);
  if (preparedAgent) {
    return preparedAgent;
  }
  if (
    pane.activeCommandSource === "runweave_command" &&
    isInteractiveShellActiveCommand(pane.paneCommand)
  ) {
    return null;
  }
  if (
    pane.activeCommandSource === "pane_current_command" &&
    isInteractiveShellActiveCommand(pane.activeCommand)
  ) {
    return null;
  }
  if (shouldKeepNodeWrappedActiveCommand(existingActiveCommand ?? null, pane)) {
    return existingActiveCommand ?? null;
  }
  return pane.activeCommand;
}

export function isStalePendingAgentPrepare(
  pane: Pick<
    TmuxPaneInfo,
    | "activeCommandSource"
    | "agentPrepareCommand"
    | "agentPrepareExit"
    | "paneCommand"
  >,
): boolean {
  return Boolean(
    pane.agentPrepareExit?.startsWith("pending:") &&
      getAgentForCommand(pane.agentPrepareCommand) &&
      pane.activeCommandSource !== "runweave_command" &&
      isInteractiveShellActiveCommand(pane.paneCommand),
  );
}

function resolvePendingPreparedAgent(
  pane: Pick<
    TmuxPaneInfo,
    | "activeCommandSource"
    | "agentPrepareCommand"
    | "agentPrepareExit"
    | "paneCommand"
  >,
): TerminalState["agent"] {
  if (
    !pane.agentPrepareExit?.startsWith("pending:") ||
    isStalePendingAgentPrepare(pane)
  ) {
    return null;
  }
  const agent = getAgentForCommand(pane.agentPrepareCommand);
  if (!agent) {
    return null;
  }
  return pane.activeCommandSource === "runweave_command" ||
    !isInteractiveShellActiveCommand(pane.paneCommand)
    ? agent
    : null;
}

export async function backfillSessionAgentMetadataToPrimaryPanel(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord,
): Promise<boolean> {
  const nextTerminalState = getPanelTerminalStateForActiveCommand(
    panel.activeCommand,
    panel.terminalState,
  );
  const panels = terminalSessionManager.listPanels(session.id);
  if (
    !shouldBackfillSessionAgentMetadataToMainPanel(
      session,
      panel,
      nextTerminalState,
      panels,
    )
  ) {
    return false;
  }
  if (session.threadId) {
    panel.threadId = session.threadId;
    panel.threadProvider =
      session.threadProvider ?? session.terminalState?.agent ?? "codex";
  }
  if (session.preview) {
    panel.preview = session.preview;
  }
  panel.terminalState = session.terminalState ?? nextTerminalState;
  panel.lastActivityAt = new Date();
  await terminalSessionManager.upsertPanel(panel);
  return true;
}

export async function syncSinglePanelMetadataToSession(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord,
): Promise<boolean> {
  const runningPanels = terminalSessionManager
    .listPanels(session.id)
    .filter((candidate) => candidate.status === "running");
  if (runningPanels.length !== 1 || runningPanels[0]?.id !== panel.id) {
    return false;
  }

  let changed = false;
  const panelThreadId = panel.threadId ?? null;
  if (
    (session.threadId ?? null) !== panelThreadId ||
    (session.threadProvider ?? null) !== (panel.threadProvider ?? null)
  ) {
    await terminalSessionManager.updateSessionThreadId(
      session.id,
      panelThreadId,
      panel.threadProvider ?? null,
    );
    changed = true;
  }

  const panelPreview = panel.preview ?? null;
  if ((session.preview ?? null) !== panelPreview) {
    await terminalSessionManager.updateSessionPreview(session.id, panelPreview);
    changed = true;
  }

  if (
    panel.terminalState &&
    !terminalStatesEqual(session.terminalState, panel.terminalState)
  ) {
    await terminalSessionManager.updateSessionTerminalState(
      session.id,
      panel.terminalState,
    );
    changed = true;
  }

  if (
    session.cwd !== panel.cwd ||
    session.activeCommand !== panel.activeCommand
  ) {
    const updated = await terminalSessionManager.updateSessionMetadata(
      session.id,
      {
        cwd: panel.cwd,
        activeCommand: panel.activeCommand,
      },
    );
    changed = changed || Boolean(updated);
  }

  return changed;
}

export async function clearMultiPanelMetadataFromSession(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  panels: TerminalPanelRecord[],
): Promise<boolean> {
  const runningPanels = panels.filter((panel) => panel.status === "running");
  if (runningPanels.length <= 1) {
    return false;
  }

  let changed = false;
  if (session.threadId) {
    await terminalSessionManager.updateSessionThreadId(session.id, null);
    changed = true;
  }
  if (session.preview) {
    await terminalSessionManager.updateSessionPreview(session.id, null);
    changed = true;
  }
  if (session.activeCommand !== null) {
    await terminalSessionManager.updateSessionMetadata(session.id, {
      cwd: session.cwd,
      activeCommand: null,
    });
    changed = true;
  }

  const aggregateState = aggregatePanelTerminalState(runningPanels);
  if (!terminalStatesEqual(session.terminalState, aggregateState)) {
    await terminalSessionManager.updateSessionTerminalState(
      session.id,
      aggregateState,
    );
    changed = true;
  }

  return changed;
}

export function recordPanelEvent(
  terminalSessionManager: TerminalSessionManager,
  terminalEventService: TerminalEventService | undefined,
  session: TerminalSessionRecord,
  kind:
    | "terminal_panel_created"
    | "terminal_panel_updated"
    | "terminal_panel_deleted"
    | "terminal_panel_focused"
    | "terminal_panel_input_sent",
  payload: Record<string, unknown>,
): void {
  const workspace = toPanelWorkspacePayload(terminalSessionManager, session.id);
  if (!workspace) {
    return;
  }
  terminalEventService?.record({
    kind,
    terminalSessionId: session.id,
    projectId: session.projectId,
    payload: {
      ...payload,
      terminalSessionId: session.id,
      workspace,
    } as never,
  });
}
