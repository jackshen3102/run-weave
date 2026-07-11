import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import type { TerminalPanelListItem } from "@runweave/shared/terminal/panel";
import type { TerminalSessionStatusResponse } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import { hasCodexReadyPrompt } from "@runweave/shared/terminal-agent-readiness";
import {
  AGENT_PROMPT_PATTERN,
  agentNameOrNull,
  buildOperationId,
  commandName,
  stripTerminalControlSequences,
  wait,
} from "./terminal-agent-inference.js";

const CODEX_SKIP_UPDATE_ON_STARTUP_COMMAND =
  "codex -c check_for_update_on_startup=false";

type AgentPreparationStatus =
  | "not_requested"
  | "already_ready"
  | "cleared_existing"
  | "started"
  | "restarted";

export interface AgentPreparationResult {
  status: AgentPreparationStatus;
  requestedAgent: string | null;
  previousAgent: string | null;
  panelId?: string | null;
  terminalState: TerminalState | null;
  actions: string[];
}

export async function prepareAgentSession(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  agent: string | undefined;
  agentOverwrite: boolean;
  agentStartCommand: string | undefined;
  agentClearCommand: string;
  agentExitCommand: string | undefined;
  agentStartTimeoutMs: number;
  panel: string | undefined;
  role: string | undefined;
}): Promise<AgentPreparationResult> {
  if (!params.agent) {
    if (params.agentOverwrite) {
      throw new CliError("--agent-overwrite requires --agent", 2);
    }
    return {
      status: "not_requested",
      requestedAgent: null,
      previousAgent: null,
      panelId: null,
      terminalState: null,
      actions: [],
    };
  }
  if (!isValidAgentName(params.agent)) {
    throw new CliError(
      "--agent must contain only letters, numbers, '.', '_' or '-'",
      2,
    );
  }
  if (
    !Number.isFinite(params.agentStartTimeoutMs) ||
    params.agentStartTimeoutMs < 0
  ) {
    throw new CliError(
      "--agent-start-timeout-ms must be a non-negative number",
      2,
    );
  }

  const actions: string[] = [];
  const targetPanel = await resolveSendTargetPanel(params);
  const initial = await getAgentSessionSnapshot(params);
  if (initial.session.status !== "running") {
    throw new CliError("Terminal session is not running", 4);
  }

  const initialAgent = resolveCurrentAgent(initial);
  if (isRequestedAgentReady(initial, params.agent)) {
    if (!params.agentOverwrite) {
      return {
        status: "already_ready",
        requestedAgent: params.agent,
        previousAgent: initialAgent,
        panelId: targetPanel?.panelId ?? null,
        terminalState: initial.terminalState,
        actions,
      };
    }
    await sendAgentControlLine(params, params.agentClearCommand);
    actions.push("clear");
    const terminalState = await waitForRequestedAgent(params, params.agent);
    return {
      status: "cleared_existing",
      requestedAgent: params.agent,
      previousAgent: initialAgent,
      panelId: targetPanel?.panelId ?? null,
      terminalState,
      actions,
    };
  }

  if (initialAgent && !params.agentOverwrite) {
    throw new CliError(
      `Terminal is already using agent "${initialAgent}". Pass --agent-overwrite to replace it with "${params.agent}".`,
      2,
    );
  }

  if (initialAgent) {
    await sendAgentControlLine(
      params,
      params.agentExitCommand ?? getDefaultAgentExitCommand(initialAgent),
    );
    actions.push("exit_existing");
    await waitForNoAgent(params);
  }

  await sendAgentControlLine(
    params,
    resolveAgentStartCommand({
      agent: params.agent,
      agentStartCommand: params.agentStartCommand,
    }),
  );
  actions.push("start");
  const terminalState = await waitForRequestedAgent(params, params.agent);
  return {
    status: initialAgent ? "restarted" : "started",
    requestedAgent: params.agent,
    previousAgent: initialAgent,
    panelId: targetPanel?.panelId ?? null,
    terminalState,
    actions,
  };
}

function resolveAgentStartCommand(params: {
  agent: string;
  agentStartCommand: string | undefined;
}): string {
  if (params.agentStartCommand) {
    return withCodexSkipUpdateOnStartup(params.agentStartCommand);
  }
  if (params.agent.toLowerCase() === "codex") {
    return CODEX_SKIP_UPDATE_ON_STARTUP_COMMAND;
  }
  return params.agent;
}

function withCodexSkipUpdateOnStartup(command: string): string {
  if (command.includes("check_for_update_on_startup")) {
    return command;
  }
  const match = /^(\S+)(.*)$/s.exec(command.trim());
  if (!match) {
    return command;
  }
  const executable = match[1];
  const rest = match[2] ?? "";
  if (!executable) {
    return command;
  }
  if (commandName(executable).toLowerCase() !== "codex") {
    return command;
  }
  return `${executable} -c check_for_update_on_startup=false${rest}`;
}

async function getAgentSessionSnapshot(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  panel: string | undefined;
  role: string | undefined;
}): Promise<{
  session: TerminalSessionStatusResponse;
  terminalState: TerminalState;
  panel: TerminalPanelListItem | null;
}> {
  const [session, statePayload, panel] = await Promise.all([
    params.client.getSession(params.terminalSessionId),
    params.client.getCurrentTerminalState(params.terminalSessionId),
    resolveSendTargetPanel(params),
  ]);
  return {
    session,
    terminalState: statePayload.terminalState,
    panel,
  };
}

function resolveCurrentAgent(snapshot: {
  session: Pick<TerminalSessionStatusResponse, "activeCommand">;
  terminalState: TerminalState;
  panel?: Pick<TerminalPanelListItem, "activeCommand"> | null;
}): string | null {
  const panelAgent = agentNameOrNull(snapshot.panel?.activeCommand ?? null);
  if (snapshot.panel) {
    return panelAgent;
  }
  return (
    (snapshot.terminalState.state !== "shell_idle"
      ? snapshot.terminalState.agent
      : null) ?? agentNameOrNull(snapshot.session.activeCommand)
  );
}

function isRequestedAgentReady(
  snapshot: {
    session: Pick<
      TerminalSessionStatusResponse,
      "activeCommand" | "scrollback"
    >;
    terminalState: TerminalState;
    panel?: Pick<TerminalPanelListItem, "activeCommand"> | null;
  },
  agent: string,
): boolean {
  if (snapshot.panel) {
    return agentNameOrNull(snapshot.panel.activeCommand) === agent;
  }
  if (
    snapshot.terminalState.state === "agent_starting" &&
    resolveCurrentAgent(snapshot) === agent &&
    isAgentReadyPrompt(snapshot.session.scrollback, agent)
  ) {
    return true;
  }
  return (
    snapshot.terminalState.state === "agent_idle" &&
    resolveCurrentAgent(snapshot) === agent
  );
}

function isAgentReadyPrompt(scrollback: string, agent: string): boolean {
  if (agent === "codex") {
    return hasCodexReadyPrompt(scrollback);
  }
  return AGENT_PROMPT_PATTERN.test(stripTerminalControlSequences(scrollback));
}

async function sendAgentControlLine(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
    panel: string | undefined;
    role: string | undefined;
  },
  command: string,
): Promise<void> {
  const targetPanel = await resolveSendTargetPanel(params);
  await params.client.sendInput(params.terminalSessionId, {
    operationId: buildOperationId(),
    data: command,
    mode: "line",
    ...(targetPanel ? { panelId: targetPanel.panelId } : {}),
    ...(!targetPanel && params.role ? { role: params.role } : {}),
  });
}

async function waitForRequestedAgent(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
    agentStartTimeoutMs: number;
    panel: string | undefined;
    role: string | undefined;
  },
  agent: string,
): Promise<TerminalState> {
  const snapshot = await waitForAgentCondition(params, (next) =>
    isRequestedAgentReady(next, agent),
  );
  return snapshot.terminalState;
}

async function waitForNoAgent(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  agentStartTimeoutMs: number;
  panel: string | undefined;
  role: string | undefined;
}): Promise<void> {
  await waitForAgentCondition(
    params,
    (next) => resolveCurrentAgent(next) === null,
  );
}

async function waitForAgentCondition(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
    agentStartTimeoutMs: number;
    panel: string | undefined;
    role: string | undefined;
  },
  predicate: (snapshot: {
    session: TerminalSessionStatusResponse;
    terminalState: TerminalState;
    panel: TerminalPanelListItem | null;
  }) => boolean,
): Promise<{
  session: TerminalSessionStatusResponse;
  terminalState: TerminalState;
  panel: TerminalPanelListItem | null;
}> {
  const startedAt = Date.now();
  let lastSnapshot = await getAgentSessionSnapshot(params);
  while (Date.now() - startedAt <= params.agentStartTimeoutMs) {
    if (predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await wait(500);
    lastSnapshot = await getAgentSessionSnapshot(params);
  }
  throw new CliError(
    `Timed out waiting for terminal agent state. Last state=${lastSnapshot.terminalState.state}, agent=${lastSnapshot.terminalState.agent ?? "none"}, activeCommand=${lastSnapshot.session.activeCommand ?? "none"}`,
    3,
  );
}

export async function resolveSendTargetPanel(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  panel: string | undefined;
  role: string | undefined;
}): Promise<TerminalPanelListItem | null> {
  if (!params.panel && !params.role) {
    return null;
  }
  const workspace = await params.client.listPanels(params.terminalSessionId);
  const requested = params.panel ?? params.role;
  const target = workspace.panels.find((panel) =>
    params.panel
      ? panel.panelId === requested ||
        panel.alias === requested ||
        panel.role === requested
      : panel.role === requested,
  );
  if (!target) {
    throw new CliError(
      params.panel
        ? `Terminal panel not found: ${params.panel}`
        : `Terminal panel role not found: ${params.role}`,
      4,
    );
  }
  return target;
}

function isValidAgentName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function getDefaultAgentExitCommand(agent: string): string {
  if (agent === "codex" || agent === "traex" || agent === "traecli") {
    return "/quit";
  }
  return "/exit";
}
