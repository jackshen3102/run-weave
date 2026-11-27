import type { TerminalStateExplain } from "@runweave/shared/terminal/events";
import type { TerminalInputMode } from "@runweave/shared/terminal/input";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type {
  TerminalSendAndWaitResponse,
  TerminalWaitOutputResponse,
  TerminalWaitTargetState,
} from "@runweave/shared/terminal/wait";
import { getBooleanOption, getStringOption } from "../args.js";
import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError, HttpError } from "../errors.js";
import { tailLines, writeOutput, type OutputMode } from "../output/format.js";
import {
  buildOperationId,
  DEFAULT_AGENT_START_TIMEOUT_MS,
} from "./terminal-agent.js";
import {
  prepareAgentSession,
  resolveSendTargetPanel,
} from "./terminal-agent-preparation.js";

const UNSUPPORTED_BACKEND_MESSAGE =
  "当前 Backend 不支持该能力，请升级服务端";

export function isUnsupportedEndpointError(
  error: unknown,
  terminalSessionId: string,
): boolean {
  if (!(error instanceof HttpError)) {
    return false;
  }
  if (error.status === 501) {
    return true;
  }
  if (error.status !== 404) {
    return false;
  }
  // Distinguish missing route (Express default HTML/text 404) from JSON "Terminal session not found".
  const message = error.message.toLowerCase();
  if (
    message.includes("terminal session not found") ||
    message.includes("panel not found") ||
    error.payload?.message === "Terminal session not found"
  ) {
    return false;
  }
  return !error.payload || message.includes(`/${terminalSessionId}/`);
}

export function parseWaitUntilOption(
  raw: string | undefined,
): TerminalWaitTargetState[] | undefined {
  if (!raw) {
    return undefined;
  }
  const items = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new CliError("--until must specify at least one of: idle, blocked", 2);
  }
  const result: TerminalWaitTargetState[] = [];
  for (const item of items) {
    if (item !== "idle" && item !== "blocked") {
      throw new CliError(
        `Invalid --until target "${item}"; expected idle or blocked`,
        2,
      );
    }
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

export function parseBoundedIntegerOption(
  options: Record<string, string | boolean>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = getStringOption(options, name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(
      `--${name} must be an integer between ${min} and ${max}`,
      2,
    );
  }
  return parsed;
}

export function formatTerminalStateExplain(
  terminalSessionId: string,
  terminalState: TerminalState,
  explain: TerminalStateExplain,
): string {
  const lines: string[] = [
    `session: ${terminalSessionId} (${explain.sessionStatus})`,
    `effectiveState: ${terminalState.state}${terminalState.agent ? ` (agent=${terminalState.agent})` : ""}`,
    `winningSource: ${explain.winningSource}`,
    `panels (${explain.panels.length}):`,
  ];

  for (const panel of explain.panels) {
    const label = panel.alias ? `${panel.panelId} [${panel.alias}]` : panel.panelId;
    const panelState = panel.terminalState
      ? `${panel.terminalState.state}${panel.terminalState.agent ? `:${panel.terminalState.agent}` : ""}`
      : "none";
    const lease = panel.agentLease
      ? `${panel.agentLease.phase}:${panel.agentLease.provider}${panel.agentLease.operationId ? `@${panel.agentLease.operationId}` : ""}`
      : "none";
    const osc = panel.oscProgramStatus
      ? `${panel.oscProgramStatus.state}${panel.oscProgramStatus.waitKind ? `(${panel.oscProgramStatus.waitKind})` : ""}@${panel.oscProgramStatus.source}`
      : "none";
    const waits: string[] = [];
    if (panel.pendingPermissionRequest.pending) {
      waits.push("claude_permission");
    }
    if (panel.pendingQuestion.pending) {
      waits.push(`${panel.pendingQuestion.provider ?? "agent"}_question`);
    }
    if (panel.piWaitState?.waiting) {
      waits.push(`pi:${panel.piWaitState.event ?? "waiting"}`);
    } else if (panel.piWaitState?.failed) {
      waits.push("pi:failed");
    }
    lines.push(
      `  - ${label}: status=${panel.status} cmd=${panel.activeCommand ?? "-"} state=${panelState} lease=${lease} osc7501=${osc} waits=${waits.length > 0 ? waits.join(",") : "none"}`,
    );
  }

  const active = explain.attention.activeSlot;
  if (active) {
    lines.push(
      `attention.activeSlot: state=${active.state}${active.actionKind ? ` actionKind=${active.actionKind}` : ""} panel=${active.panelId ?? "-"} evidence=${active.source.evidence} updatedAt=${active.updatedAt}`,
    );
  } else {
    lines.push("attention.activeSlot: none");
  }

  if (explain.attention.suppressedCandidates.length > 0) {
    lines.push(
      `attention.suppressedCandidates (${explain.attention.suppressedCandidates.length}):`,
    );
    for (const item of explain.attention.suppressedCandidates) {
      lines.push(
        `  - state=${item.state}${item.actionKind ? ` actionKind=${item.actionKind}` : ""} panel=${item.panelId ?? "-"} evidence=${item.evidence} (${item.reason})`,
      );
    }
  } else {
    lines.push("attention.suppressedCandidates: none");
  }

  return lines.join("\n");
}

function formatSendAndWaitPlain(response: TerminalSendAndWaitResponse): string {
  const parts = [
    `outcome=${response.outcome}`,
    ...(response.code ? [`code=${response.code}`] : []),
    `matchedState=${response.matchedState ?? "-"}`,
    `terminalState=${response.terminalState.state}${response.terminalState.agent ? `:${response.terminalState.agent}` : ""}`,
    `attention=${response.attentionState ?? "-"}${response.attentionActionKind ? `(${response.attentionActionKind})` : ""}`,
    `elapsedMs=${response.elapsedMs}`,
  ];
  return response.note ? `${parts.join(" ")}\n${response.note}` : parts.join(" ");
}

export async function runSendAndWaitCommand(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  text: string;
  options: Record<string, string | boolean>;
  inputMode: TerminalInputMode;
  inputModeProvided: boolean;
  enter: boolean;
  requestedAgent: string | undefined;
  mode: OutputMode;
  stdout: Pick<NodeJS.WriteStream, "write">;
}): Promise<void> {
  const until = parseWaitUntilOption(getStringOption(params.options, "until"));
  const timeoutMs = parseBoundedIntegerOption(
    params.options,
    "timeout-ms",
    1_000,
    600_000,
  );
  const activityGateMs = parseBoundedIntegerOption(
    params.options,
    "activity-gate-ms",
    100,
    30_000,
  );
  const allowBlocked = getBooleanOption(params.options, "allow-blocked");
  const rejectIfBlockedOption = params.options["reject-if-blocked"];
  const rejectIfBlocked =
    !allowBlocked && rejectIfBlockedOption !== false && rejectIfBlockedOption !== "false";

  const panelOption = getStringOption(params.options, "panel");
  const roleOption = getStringOption(params.options, "role");

  let resolvedPanelId: string | undefined;
  if (params.requestedAgent) {
    const prep = await prepareAgentSession({
      client: params.client,
      terminalSessionId: params.terminalSessionId,
      panel: panelOption,
      role: roleOption,
      agent: params.requestedAgent,
      agentOverwrite: getBooleanOption(params.options, "agent-overwrite"),
      agentStartCommand: getStringOption(params.options, "agent-start-command"),
      agentClearCommand:
        getStringOption(params.options, "agent-clear-command") ??
        (params.requestedAgent === "pi" ? "/new" : "/clear"),
      agentExitCommand: getStringOption(params.options, "agent-exit-command"),
      agentStartTimeoutMs: Number(
        getStringOption(params.options, "agent-start-timeout-ms") ??
          DEFAULT_AGENT_START_TIMEOUT_MS,
      ),
    });
    resolvedPanelId = prep.panelId ?? undefined;
  } else if (panelOption || roleOption) {
    const target = await resolveSendTargetPanel({
      client: params.client,
      terminalSessionId: params.terminalSessionId,
      panel: panelOption,
      role: roleOption,
    });
    resolvedPanelId = target?.panelId;
  }

  const effectiveMode: TerminalInputMode = params.inputModeProvided
    ? params.inputMode
    : "line";
  const data =
    effectiveMode === "raw" && params.enter ? `${params.text}\r` : params.text;

  try {
    const response = await params.client.sendAndWait(params.terminalSessionId, {
      operationId: buildOperationId(),
      data,
      ...(resolvedPanelId ? { panelId: resolvedPanelId } : {}),
      ...(!resolvedPanelId && roleOption ? { role: roleOption } : {}),
      mode: effectiveMode,
      ...(effectiveMode === "prompt_replace"
        ? { submit: params.options.enter !== false }
        : {}),
      wait: {
        ...(until ? { until } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(activityGateMs !== undefined ? { activityGateMs } : {}),
        rejectIfBlocked,
      },
    });
    writeOutput(
      params.stdout,
      params.mode,
      params.mode === "json" ? response : formatSendAndWaitPlain(response),
    );
  } catch (error) {
    if (isUnsupportedEndpointError(error, params.terminalSessionId)) {
      throw new CliError(UNSUPPORTED_BACKEND_MESSAGE, 4);
    }
    if (
      error instanceof HttpError &&
      error.code === "AGENT_BLOCKED" &&
      params.mode === "json"
    ) {
      writeOutput(params.stdout, "json", {
        ok: false,
        code: "AGENT_BLOCKED",
        terminalSessionId: params.terminalSessionId,
        inputAccepted: false,
        ...(error.payload ?? { message: error.message }),
      });
    }
    throw error;
  }
}

export async function runWaitOutputCommand(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  options: Record<string, string | boolean>;
  mode: OutputMode;
  stdout: Pick<NodeJS.WriteStream, "write">;
}): Promise<void> {
  const match = getStringOption(params.options, "match");
  const regex = getStringOption(params.options, "regex");
  if (Boolean(match) === Boolean(regex)) {
    throw new CliError(
      "Specify exactly one of --match <text> or --regex <pattern>",
      2,
    );
  }
  const lines = parseBoundedIntegerOption(params.options, "lines", 1, 1_000);
  const timeoutMs = parseBoundedIntegerOption(
    params.options,
    "timeout-ms",
    0,
    300_000,
  );
  const panelOption = getStringOption(params.options, "panel");
  const roleOption = getStringOption(params.options, "role");
  const resolvedTarget =
    panelOption || roleOption
      ? await resolveSendTargetPanel({
          client: params.client,
          terminalSessionId: params.terminalSessionId,
          panel: panelOption,
          role: roleOption,
        })
      : null;
  const unwrap =
    !getBooleanOption(params.options, "no-unwrap") &&
    params.options.unwrap !== false &&
    params.options.unwrap !== "false";

  let response: TerminalWaitOutputResponse;
  try {
    response = await params.client.waitOutput(params.terminalSessionId, {
      ...(resolvedTarget ? { panelId: resolvedTarget.panelId } : {}),
      ...(!resolvedTarget && roleOption ? { role: roleOption } : {}),
      ...(match !== undefined ? { match } : {}),
      ...(regex !== undefined ? { regex } : {}),
      ...(lines !== undefined ? { lines } : {}),
      unwrap,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (error) {
    if (isUnsupportedEndpointError(error, params.terminalSessionId)) {
      throw new CliError(UNSUPPORTED_BACKEND_MESSAGE, 4);
    }
    throw error;
  }

  if (params.mode === "json") {
    writeOutput(
      params.stdout,
      "json",
      response.matched ? response : { ...response, code: "WAIT_TIMEOUT" },
    );
  } else if (response.matched) {
    writeOutput(params.stdout, "plain", response.matchedLine ?? "");
  }

  if (!response.matched) {
    throw new CliError(
      `WAIT_TIMEOUT: Output did not match within ${response.elapsedMs}ms`,
      1,
    );
  }
}

export async function runUnwrappedSnapshotCommand(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  panelId: string | undefined;
  role: string | undefined;
  lineCount: number;
  mode: OutputMode;
  stdout: Pick<NodeJS.WriteStream, "write">;
}): Promise<void> {
  try {
    const snapshot = await params.client.getSessionSnapshot(
      params.terminalSessionId,
      {
        panelId: params.panelId,
        role: params.role,
        lines: params.lineCount,
        unwrap: true,
      },
    );
    const tail = tailLines(snapshot.scrollback, params.lineCount);
    writeOutput(
      params.stdout,
      params.mode,
      params.mode === "json" ? { ...snapshot, tail } : tail,
    );
  } catch (error) {
    if (isUnsupportedEndpointError(error, params.terminalSessionId)) {
      throw new CliError(UNSUPPORTED_BACKEND_MESSAGE, 4);
    }
    throw error;
  }
}
