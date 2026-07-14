import { randomUUID } from "node:crypto";
import {
  type PrepareTerminalAgentRequest,
  type PrepareTerminalAgentResponse,
  type TerminalAgentPreparationAgent,
  type TerminalAgentPreparationFailureDetails,
} from "@runweave/shared/terminal/agent-preparation";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager";
import {
  buildPaneTarget,
  TerminalPanelError,
  type TerminalPanelOptions,
  type TerminalPanelTargetResolution,
} from "./panel-common";
import { createTerminalPanelSplit } from "./panel-split";
import { resolvePanelTarget } from "./panel-targets";
import { isInteractiveShellLaunch } from "../tmux-output-watcher-helpers";
import { sendInputToSession } from "./input-dispatcher";

const AGENT_SHELL_STARTUP_DELAY_MS = 10_000;
const AGENT_EXIT_PANE_OPTION = "@runweave_agent_prepare_exit";
const CODEX_SKIP_UPDATE_ON_STARTUP_ARGS = [
  "-c",
  "check_for_update_on_startup=false",
] as const;

export async function prepareTerminalAgent(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: TerminalPanelOptions,
  request: PrepareTerminalAgentRequest,
): Promise<PrepareTerminalAgentResponse> {
  const operationId = `terminal_agent_prepare_${randomUUID()}`;
  let target: TerminalPanelTargetResolution | null = null;
  let createdPanel = false;
  let preparationPanelId: string | null = null;
  if (request.panelId) {
    preparationPanelId = request.panelId;
    if (
      !terminalSessionManager.beginPanelAgentPreparation(
        session.id,
        request.panelId,
        operationId,
        request.agent,
      )
    ) {
      throwPreparationError({
        phase: "cli_launch",
        operationId,
        session,
        panel: terminalSessionManager.getPanel(request.panelId) ?? null,
        createdPanel: false,
        provider: request.agent,
        message:
          "Terminal agent preparation already in progress for this panel",
      });
    }
  }
  const panelIdsBeforeCreate = new Set(
    terminalSessionManager.listPanels(session.id).map((panel) => panel.id),
  );
  try {
    if (request.panelId) {
      target = await resolvePanelTarget(
        terminalSessionManager,
        session,
        options,
        { panelId: request.panelId },
        "explicit-or-active",
      );
    } else {
      const created = await createTerminalPanelSplit(
        terminalSessionManager,
        session,
        options,
        {
          sourcePanelId: request.sourcePanelId,
          direction: request.direction ?? "right",
          alias: request.alias,
          role: request.role,
          cwd: request.cwd,
          focus: request.focus,
          skipPaneReadyWait: true,
        },
      );
      createdPanel = true;
      target = {
        panel: created.panel,
        paneTarget: buildPaneTarget(
          session,
          options.tmuxService!,
          created.panel,
        ),
      };
    }
  } catch (error) {
    if (preparationPanelId) {
      terminalSessionManager.endPanelAgentPreparation(
        session.id,
        preparationPanelId,
        operationId,
      );
    }
    const partialIdentity = readPartialPanelIdentity(error);
    const partiallyCreatedPanel = request.panelId
      ? null
      : (terminalSessionManager
          .listPanels(session.id)
          .find((panel) => !panelIdsBeforeCreate.has(panel.id)) ?? null);
    throwPreparationError({
      phase: "panel_create",
      operationId,
      session,
      panel: target?.panel ?? partiallyCreatedPanel,
      panelIdentity: partialIdentity,
      createdPanel:
        createdPanel ||
        Boolean(partiallyCreatedPanel) ||
        Boolean(partialIdentity),
      provider: request.agent,
      message: "Failed to create or resolve terminal agent panel",
      cause: error,
    });
  }

  const panel = target.panel;
  const paneTarget = target.paneTarget;
  if (!preparationPanelId) {
    preparationPanelId = panel.id;
    if (
      !terminalSessionManager.beginPanelAgentPreparation(
        session.id,
        panel.id,
        operationId,
        request.agent,
      )
    ) {
      throwPreparationError({
        phase: "cli_launch",
        operationId,
        session,
        panel,
        createdPanel,
        provider: request.agent,
        message:
          "Terminal agent preparation already in progress for this panel",
      });
    }
  }
  try {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const reusingPanel = request.panelId !== undefined;

    if (
      panel.status !== "running" ||
      panel.terminalState?.state === "agent_running" ||
      panel.terminalState?.state === "agent_starting"
    ) {
      throwPreparationError({
        phase: "cli_launch",
        operationId,
        session,
        panel,
        createdPanel,
        provider: request.agent,
        message: "Terminal panel is not ready to start the requested agent",
      });
    }

    if (!options.tmuxService) {
      throwPreparationError({
        phase: "cli_launch",
        operationId,
        session,
        panel,
        createdPanel,
        provider: request.agent,
        message: "Terminal tmux service unavailable",
      });
    }

    await terminalSessionManager.updatePanelTerminalState(
      panel.id,
      {
        state: "agent_starting",
        agent: request.agent,
      },
      operationId,
    );

    try {
      if (reusingPanel) {
        if (!isInteractiveShellLaunch(session.command, session.args)) {
          throw new Error(
            "Terminal session command is not a persistent interactive shell",
          );
        }
        await options.tmuxService.respawnPane(paneTarget, {
          command: session.command,
          args: session.args,
          cwd: request.cwd?.trim() || panel.cwd || session.cwd,
          env: {
            RUNWEAVE_TERMINAL_SESSION_ID: session.id,
            RUNWEAVE_TERMINAL_PANEL_ID: panel.id,
            RUNWEAVE_PROJECT_ID: session.projectId,
          },
        });
      }
      if (createdPanel || reusingPanel) {
        await delay(AGENT_SHELL_STARTUP_DELAY_MS);
      }
      assertPreparationTargetCurrent({
        terminalSessionManager,
        session,
        panel,
        paneTarget,
        operationId,
        provider: request.agent,
      });
      await options.tmuxService.setPaneOption(
        paneTarget,
        AGENT_EXIT_PANE_OPTION,
        `pending:${operationId}`,
      );
      await sendInputToSession(
        terminalSessionManager,
        options,
        session,
        buildAgentLaunchCommand(request, operationId),
        "line",
        operationId,
        paneTarget,
      );
    } catch (error) {
      throwPreparationError({
        phase: "cli_launch",
        operationId,
        session,
        panel,
        createdPanel,
        provider: request.agent,
        message: "Failed to launch terminal agent",
        cause: error,
      });
    }

    try {
      const currentPanel = terminalSessionManager.getPanel(panel.id);
      if (!currentPanel) {
        throw new Error("Terminal agent panel missing after command submission");
      }
      return {
        operationId,
        terminalSessionId: session.id,
        panelId: currentPanel.id,
        tmuxPaneId: currentPanel.tmuxPaneId,
        provider: request.agent,
        threadId: null,
        status: "starting",
        createdPanel,
        startedAt,
      };
    } catch (error) {
      if (error instanceof TerminalPanelError) {
        throw error;
      }
      throwPreparationError({
        phase: "cli_launch",
        operationId,
        session,
        panel: terminalSessionManager.getPanel(panel.id) ?? panel,
        createdPanel,
        provider: request.agent,
        message: "Failed to submit terminal agent initial prompt",
        cause: error,
      });
    }
  } finally {
    terminalSessionManager.endPanelAgentPreparation(
      session.id,
      preparationPanelId,
      operationId,
    );
  }
  throw new Error("Terminal agent preparation ended without a result");
}

function assertPreparationTargetCurrent(input: {
  terminalSessionManager: TerminalSessionManager;
  session: TerminalSessionRecord;
  panel: TerminalPanelRecord;
  paneTarget: TerminalPanelTargetResolution["paneTarget"];
  operationId: string;
  provider: TerminalAgentPreparationAgent;
}): void {
  const currentSession = input.terminalSessionManager.getSession(
    input.session.id,
  );
  const currentPanel = input.terminalSessionManager.getPanel(input.panel.id);
  if (
    currentSession?.status !== "running" ||
    currentPanel?.status !== "running" ||
    currentPanel.terminalSessionId !== input.session.id ||
    currentPanel.tmuxPaneId !== input.paneTarget.paneId ||
    !input.terminalSessionManager.matchesPanelAgentPreparation(
      input.session.id,
      input.panel.id,
      input.operationId,
      input.provider,
    )
  ) {
    throw new Error(
      "Terminal agent preparation was cancelled or its panel disappeared",
    );
  }
}

function buildAgentLaunchCommand(
  request: PrepareTerminalAgentRequest,
  operationId: string,
): string {
  const command = request.command?.trim() || request.agent;
  const args =
    request.agent === "codex"
      ? withCodexSkipUpdateOnStartupArgs(request.args ?? [])
      : (request.args ?? []);
  const invocation = request.commandLine?.trim()
    ? `${request.commandLine.trim()} ${shellQuote(request.prompt)}`
    : [command, ...args.map(shellQuote), shellQuote(request.prompt)].join(" ");
  return `export RUNWEAVE_TERMINAL_AGENT_OPERATION_ID=${shellQuote(operationId)}; ${invocation}; __runweave_agent_exit=$?; unset RUNWEAVE_TERMINAL_AGENT_OPERATION_ID; tmux set-option -p -t "$TMUX_PANE" ${AGENT_EXIT_PANE_OPTION} "exit:${operationId}:$__runweave_agent_exit"`;
}

function withCodexSkipUpdateOnStartupArgs(
  args: readonly string[],
): readonly string[] {
  return args.some((arg) => arg.includes("check_for_update_on_startup"))
    ? args
    : [...CODEX_SKIP_UPDATE_ON_STARTUP_ARGS, ...args];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function throwPreparationError(input: {
  phase: TerminalAgentPreparationFailureDetails["phase"];
  operationId: string;
  session: TerminalSessionRecord;
  panel: TerminalPanelRecord | null;
  createdPanel: boolean;
  provider: TerminalAgentPreparationAgent;
  message: string;
  cause?: unknown;
  exitCode?: number;
  panelIdentity?: { panelId: string; tmuxPaneId: string } | null;
}): never {
  const details: TerminalAgentPreparationFailureDetails = {
    phase: input.phase,
    operationId: input.operationId,
    terminalSessionId: input.session.id,
    panelId: input.panel?.id ?? input.panelIdentity?.panelId ?? null,
    tmuxPaneId:
      input.panel?.tmuxPaneId ?? input.panelIdentity?.tmuxPaneId ?? null,
    createdPanel: input.createdPanel,
    provider: input.provider,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  };
  const causeMessage =
    input.cause instanceof Error ? `: ${input.cause.message}` : "";
  throw new TerminalPanelError(
    input.phase === "lifecycle_timeout" ? 504 : 409,
    `${input.message}${causeMessage}`,
    details,
  );
}

function readPartialPanelIdentity(
  error: unknown,
): { panelId: string; tmuxPaneId: string } | null {
  if (!(error instanceof TerminalPanelError)) {
    return null;
  }
  const partialPanel = (
    error.details as
      | {
          partialPanel?: { panelId?: unknown; tmuxPaneId?: unknown };
        }
      | undefined
  )?.partialPanel;
  return typeof partialPanel?.panelId === "string" &&
    typeof partialPanel.tmuxPaneId === "string"
    ? { panelId: partialPanel.panelId, tmuxPaneId: partialPanel.tmuxPaneId }
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
