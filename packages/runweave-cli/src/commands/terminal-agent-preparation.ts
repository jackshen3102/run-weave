import {
  DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT,
  type TerminalAgentPreparationAgent,
} from "@runweave/shared/terminal/agent-preparation";
import type { TerminalPanelListItem } from "@runweave/shared/terminal/panel";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import { buildOperationId, wait } from "./terminal-agent-inference.js";

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
  operationId?: string;
  threadId?: string | null;
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

  const session = await params.client.getSession(params.terminalSessionId);
  if (session.status !== "running") {
    throw new CliError("Terminal session is not running", 4);
  }
  const targetPanel = await resolvePreparationTargetPanel(params);
  const previousAgent = getPanelAgent(targetPanel);
  const actions: string[] = [];

  if (isRequestedAgentReady(targetPanel, params.agent)) {
    if (!params.agentOverwrite) {
      return {
        status: "already_ready",
        requestedAgent: params.agent,
        previousAgent,
        panelId: targetPanel.panelId,
        terminalState: targetPanel.terminalState ?? null,
        actions,
      };
    }
    await sendAgentControlLine(params, targetPanel, params.agentClearCommand);
    actions.push("clear");
    return {
      status: "cleared_existing",
      requestedAgent: params.agent,
      previousAgent,
      panelId: targetPanel.panelId,
      terminalState: targetPanel.terminalState ?? null,
      actions,
    };
  }

  if (previousAgent && !params.agentOverwrite) {
    throw new CliError(
      `Terminal is already using agent "${previousAgent}". Pass --agent-overwrite to replace it with "${params.agent}".`,
      2,
    );
  }
  if (previousAgent) {
    await sendAgentControlLine(
      params,
      targetPanel,
      params.agentExitCommand ?? getDefaultAgentExitCommand(previousAgent),
    );
    actions.push("exit_existing");
    await waitForPanelState(
      params,
      targetPanel.panelId,
      (panel) => panel.terminalState?.state === "shell_idle",
    );
  }

  if (!isPreparationAgent(params.agent)) {
    await sendAgentControlLine(
      params,
      targetPanel,
      resolveAgentStartCommand(params.agent, params.agentStartCommand),
    );
    actions.push("start");
    const currentPanel = await getPanelById(params, targetPanel.panelId);
    return {
      status: previousAgent ? "restarted" : "started",
      requestedAgent: params.agent,
      previousAgent,
      panelId: targetPanel.panelId,
      terminalState: currentPanel.terminalState ?? null,
      actions,
    };
  }

  const prepared = await params.client.prepareAgent(params.terminalSessionId, {
    agent: params.agent,
    prompt: DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT,
    panelId: targetPanel.panelId,
    cwd: targetPanel.cwd,
    role: targetPanel.role,
    ...(params.agentStartCommand
      ? {
          commandLine: resolveAgentStartCommand(
            params.agent,
            params.agentStartCommand,
          ),
        }
      : {}),
    timeoutMs: params.agentStartTimeoutMs,
  });
  actions.push("start");
  return {
    status: previousAgent ? "restarted" : "started",
    requestedAgent: params.agent,
    previousAgent,
    panelId: prepared.panelId,
    terminalState: { state: "agent_starting", agent: prepared.provider },
    actions,
    operationId: prepared.operationId,
    threadId: prepared.threadId,
  };
}

async function resolvePreparationTargetPanel(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  panel: string | undefined;
  role: string | undefined;
}): Promise<TerminalPanelListItem> {
  const requested = await resolveSendTargetPanel(params);
  if (requested) return requested;
  const workspace = await params.client.listPanels(params.terminalSessionId);
  const active =
    workspace.panels.find(
      (panel) => panel.panelId === workspace.activePanelId,
    ) ?? workspace.panels[0];
  if (!active) throw new CliError("Terminal panel not found", 4);
  return active;
}

export async function resolveSendTargetPanel(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  panel: string | undefined;
  role: string | undefined;
}): Promise<TerminalPanelListItem | null> {
  if (!params.panel && !params.role) return null;
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

async function sendAgentControlLine(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
  },
  panel: TerminalPanelListItem,
  data: string,
): Promise<void> {
  await params.client.sendInput(params.terminalSessionId, {
    operationId: buildOperationId(),
    data,
    mode: "line",
    panelId: panel.panelId,
  });
}

async function waitForPanelState(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
    agentStartTimeoutMs: number;
  },
  panelId: string,
  predicate: (panel: TerminalPanelListItem) => boolean,
): Promise<TerminalPanelListItem> {
  const startedAt = Date.now();
  let panel = await getPanelById(params, panelId);
  while (Date.now() - startedAt <= params.agentStartTimeoutMs) {
    if (predicate(panel)) return panel;
    await wait(Math.min(500, params.agentStartTimeoutMs));
    panel = await getPanelById(params, panelId);
  }
  throw new CliError(
    `Timed out waiting for terminal agent state. Last state=${panel.terminalState?.state ?? "unknown"}, agent=${panel.terminalState?.agent ?? "none"}`,
    3,
  );
}

async function getPanelById(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
  },
  panelId: string,
): Promise<TerminalPanelListItem> {
  const workspace = await params.client.listPanels(params.terminalSessionId);
  const panel = workspace.panels.find(
    (candidate) => candidate.panelId === panelId,
  );
  if (!panel) throw new CliError(`Terminal panel not found: ${panelId}`, 4);
  return panel;
}

function getPanelAgent(panel: TerminalPanelListItem): string | null {
  return panel.terminalState?.state !== "shell_idle"
    ? (panel.terminalState?.agent ?? null)
    : null;
}

function isRequestedAgentReady(
  panel: TerminalPanelListItem,
  agent: string,
): boolean {
  return (
    panel.terminalState?.state === "agent_idle" &&
    isMatchingAgent(agent, panel.terminalState.agent)
  );
}

function isMatchingAgent(agent: string, current: string | null): boolean {
  return agent === current || (agent === "traex" && current === "trae");
}

function isPreparationAgent(
  value: string,
): value is TerminalAgentPreparationAgent {
  return value === "codex" || value === "traex";
}

function isValidAgentName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function resolveAgentStartCommand(
  agent: string,
  customCommand: string | undefined,
): string {
  if (customCommand) return withCodexSkipUpdateOnStartup(customCommand);
  return agent === "codex" ? CODEX_SKIP_UPDATE_ON_STARTUP_COMMAND : agent;
}

function withCodexSkipUpdateOnStartup(command: string): string {
  if (command.includes("check_for_update_on_startup")) return command;
  const match = /^(\S+)(.*)$/s.exec(command.trim());
  if (!match?.[1] || match[1].split(/[\\/]/).at(-1) !== "codex") return command;
  return `${match[1]} -c check_for_update_on_startup=false${match[2] ?? ""}`;
}

function getDefaultAgentExitCommand(agent: string): string {
  return agent === "codex" || agent === "traex" || agent === "traecli"
    ? "/quit"
    : "/exit";
}
