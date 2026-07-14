import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import { tailLines } from "../output/format.js";
import type { TerminalInputMode } from "@runweave/shared/terminal/input";
import {
  buildOperationId,
  containsInputEcho,
  inferAgent,
  inferState,
  resolveConfirmConfidence,
  wait,
} from "./terminal-agent-inference.js";
import {
  prepareAgentSession,
  resolveSendTargetPanel,
} from "./terminal-agent-preparation.js";

export {
  buildOperationId,
  commandName,
  inferHandoffWorkloadState,
} from "./terminal-agent-inference.js";

const DEFAULT_TAIL_LINES = 120;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 3000;
export const DEFAULT_AGENT_START_TIMEOUT_MS = 120000;

export async function sendWithConfirmation(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  text: string;
  enter: boolean;
  inputMode: TerminalInputMode;
  inputModeProvided: boolean;
  panel: string | undefined;
  role: string | undefined;
  confirmMode: string;
  confirmTimeoutMs: number;
  agent: string | undefined;
  agentOverwrite: boolean;
  agentStartCommand: string | undefined;
  agentClearCommand: string;
  agentExitCommand: string | undefined;
  agentStartTimeoutMs: number;
}): Promise<Record<string, unknown>> {
  if (
    !Number.isFinite(params.confirmTimeoutMs) ||
    params.confirmTimeoutMs < 0
  ) {
    throw new CliError("--confirm-timeout-ms must be a non-negative number", 2);
  }
  if (params.confirmMode !== "none" && params.confirmMode !== "short") {
    throw new CliError("--confirm must be one of: none, short", 2);
  }
  const agentPreparation = await prepareAgentSession(params);
  const targetPanel = agentPreparation.panelId
    ? { panelId: agentPreparation.panelId }
    : await resolveSendTargetPanel(params);

  const tailBeforeSession = await params.client.getSession(
    params.terminalSessionId,
  );
  const tailBefore = tailLines(
    tailBeforeSession.scrollback,
    DEFAULT_TAIL_LINES,
  );
  const sendStartedAt = new Date().toISOString();
  const data =
    params.inputMode === "line" || params.inputMode === "prompt_replace"
      ? params.text
      : `${params.text}${params.enter ? "\r" : ""}`;
  const operationId = buildOperationId();
  const inputPayload = {
    operationId,
    data,
    ...(targetPanel ? { panelId: targetPanel.panelId } : {}),
    ...(!targetPanel && params.role ? { role: params.role } : {}),
    ...(params.inputModeProvided || params.inputMode !== "raw"
      ? { mode: params.inputMode }
      : {}),
    ...(params.inputMode === "prompt_replace" && params.enter
      ? { submit: true }
      : {}),
  };
  const inputResult = await params.client.sendInput(
    params.terminalSessionId,
    inputPayload,
  );
  if (params.confirmMode === "short" && params.confirmTimeoutMs > 0) {
    await wait(params.confirmTimeoutMs);
  }
  const tailAfterSession = await params.client.getSession(
    params.terminalSessionId,
  );
  const tailAfter = tailLines(tailAfterSession.scrollback, DEFAULT_TAIL_LINES);
  const echoObserved = containsInputEcho(tailAfter, params.text);
  const observedState = inferState(tailAfterSession, tailAfter);
  const promptChanged =
    tailBeforeSession.activeCommand !== tailAfterSession.activeCommand ||
    tailBeforeSession.status !== tailAfterSession.status;
  const confirmConfidence = resolveConfirmConfidence({
    echoObserved,
    observedState,
    promptChanged,
    inputAccepted: inputResult.inputAccepted,
  });

  return {
    operationId: inputResult.operationId,
    terminalSessionId: params.terminalSessionId,
    transport: "http",
    inputAccepted: inputResult.inputAccepted,
    inputEnqueued: inputResult.inputEnqueued,
    runtimeKind: inputResult.runtimeKind,
    acceptedAt: inputResult.acceptedAt,
    submitted:
      params.inputMode === "line" ||
      params.inputMode === "codex_slash_command" ||
      params.inputMode === "prompt_paste" ||
      params.enter ||
      /[\r\n]$/.test(params.text),
    confirmMode: params.confirmMode,
    confirmTimeoutMs:
      params.confirmMode === "short" ? params.confirmTimeoutMs : 0,
    echoObserved,
    promptChanged,
    observedState,
    confirmConfidence,
    tailBefore,
    tailAfter,
    sendStartedAt,
    hook: {
      completionExpected: true,
      expectedSource: inferAgent(tailAfterSession.activeCommand, tailAfter),
      notificationOwner: "existing-ai-cli-hooks",
    },
    agentPreparation,
    note: "Completion will be delivered by configured AI CLI hook if available.",
  };
}
