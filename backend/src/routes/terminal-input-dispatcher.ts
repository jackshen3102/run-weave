import type { SendTerminalInputResponse, TerminalInputMode } from "@runweave/shared";
import { aiDiagnosticLog } from "../diagnostic-logs/recorder";
import type { TerminalSessionManager, TerminalSessionRecord } from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  resolveTmuxTarget,
} from "../terminal/runtime-launcher";
import type { TmuxKeySequenceItem, TmuxService } from "../terminal/tmux-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import {
  buildTerminalInputOperationId,
  TERMINAL_INTERRUPT_ESCAPE_INPUT,
} from "./terminal-session-route-helpers";

const CODEX_COMPOSER_SUBMIT_DELAY_MS = 200;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const PROMPT_PASTE_CHUNK_SIZE = 3000;

type TerminalInputDispatchOptions = {
  ptyService?: PtyService;
  runtimeRegistry?: TerminalRuntimeRegistry;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  terminalStateService?: TerminalStateService;
};

function describeTerminalInput(data: string): Record<string, unknown> {
  return {
    byteLength: Buffer.byteLength(data, "utf8"),
    charLength: data.length,
    hasNewline: data.includes("\n") || data.includes("\r"),
    isEscapeOnly: data === TERMINAL_INTERRUPT_ESCAPE_INPUT,
    firstCodePoints: Array.from(data.slice(0, 8)).map((char) =>
      char.codePointAt(0),
    ),
  };
}

export function normalizeCodexSlashCommand(data: string): string | null {
  const command = data.trim();
  if (
    !command.startsWith("/") ||
    command.includes("\n") ||
    command.includes("\r")
  ) {
    return null;
  }
  return command;
}

function resolveTerminalInputData(
  data: string,
  mode: TerminalInputMode | undefined,
): string {
  if (mode === "line") {
    return `${data}\r`;
  }
  return data;
}

function buildCodexSlashCommandSequence(
  command: string,
  submitKey: "C-m" | "Tab",
): TmuxKeySequenceItem[] {
  return [
    { type: "key", key: "C-u" },
    {
      type: "literal",
      value: command,
      delayAfterMs: CODEX_COMPOSER_SUBMIT_DELAY_MS,
    },
    { type: "key", key: submitKey },
  ];
}

function buildCodexSlashCommandPtyInput(
  command: string,
  submitKey: "C-m" | "Tab",
): string {
  return `\x15${command}${submitKey === "Tab" ? "\t" : "\r"}`;
}

function buildPromptPasteInput(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

function buildPromptPastePtyInput(text: string, submitKey: "C-m" | "Tab"): string {
  return `${buildPromptPasteInput(text)}${submitKey === "Tab" ? "\t" : "\r"}`;
}

function splitPromptPaste(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += PROMPT_PASTE_CHUNK_SIZE) {
    chunks.push(value.slice(index, index + PROMPT_PASTE_CHUNK_SIZE));
  }
  return chunks;
}

function buildPromptPasteSequence(
  text: string,
  submitKey: "C-m" | "Tab",
): TmuxKeySequenceItem[] {
  return [
    ...splitPromptPaste(buildPromptPasteInput(text)).map((value) => ({
      type: "literal" as const,
      value,
    })),
    { type: "key", key: submitKey },
  ];
}

function buildTerminalLineSequence(data: string): TmuxKeySequenceItem[] {
  return [
    {
      type: "literal",
      value: data,
      delayAfterMs: CODEX_COMPOSER_SUBMIT_DELAY_MS,
    },
    { type: "key", key: "C-m" },
  ];
}

export function isMissingTerminalRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /can't find (pane|session)|no server running/i.test(message);
}

export async function sendInputToSession(
  terminalSessionManager: TerminalSessionManager,
  options: TerminalInputDispatchOptions | undefined,
  session: TerminalSessionRecord,
  data: string,
  mode?: TerminalInputMode,
  operationId?: string,
): Promise<SendTerminalInputResponse> {
  if (!options?.runtimeRegistry || !options.ptyService) {
    throw new Error("Terminal runtime service unavailable");
  }
  if (isTmuxBackedSession(session) && !options.tmuxService) {
    throw new Error("Terminal tmux service unavailable");
  }

  const ensured = await ensureTerminalRuntime({
    session,
    terminalSessionManager,
    runtimeRegistry: options.runtimeRegistry,
    ptyService: options.ptyService,
    tmuxService: options.tmuxService,
    tmuxOutputWatcher: options.tmuxOutputWatcher,
  });
  const currentTerminalState = options.terminalStateService?.getCurrent(
    session.id,
    session,
  );
  const codexSlashCommand =
    mode === "codex_slash_command" ? normalizeCodexSlashCommand(data) : null;
  const composerSubmitKey =
    currentTerminalState?.state === "agent_running" ? "Tab" : "C-m";
  const dispatchData =
    codexSlashCommand === null ? resolveTerminalInputData(data, mode) : null;
  const exitTmuxCopyMode = mode === "tmux_exit_copy_mode";
  aiDiagnosticLog("terminal input dispatch requested", {
    terminalSessionId: session.id,
    runtimeKind: isTmuxBackedSession(session) ? "tmux" : "pty",
    operationId: operationId ?? null,
    inputMode: mode ?? "raw",
    input: describeTerminalInput(dispatchData ?? codexSlashCommand ?? data),
    codexSlashSubmitKey: codexSlashCommand ? composerSubmitKey : null,
    promptPasteSubmitKey: mode === "prompt_paste" ? composerSubmitKey : null,
    exitTmuxCopyMode,
  });
  if (isTmuxBackedSession(session) && options.tmuxService) {
    const target = resolveTmuxTarget(session, options.tmuxService);
    aiDiagnosticLog("terminal tmux input dispatch selected", {
      terminalSessionId: session.id,
      operationId: operationId ?? null,
      tmuxSessionName: target.sessionName,
      socketPath: target.socketPath,
      inputMode: mode ?? "raw",
      input: describeTerminalInput(dispatchData ?? codexSlashCommand ?? data),
      codexSlashSubmitKey: codexSlashCommand ? composerSubmitKey : null,
      promptPasteSubmitKey: mode === "prompt_paste" ? composerSubmitKey : null,
      exitTmuxCopyMode,
    });
    if (exitTmuxCopyMode) {
      await options.tmuxService.cancelCopyMode(target);
    } else if (codexSlashCommand) {
      await options.tmuxService.sendKeySequence(
        target,
        buildCodexSlashCommandSequence(codexSlashCommand, composerSubmitKey),
      );
    } else if (mode === "prompt_paste") {
      await options.tmuxService.sendKeySequence(
        target,
        buildPromptPasteSequence(data, composerSubmitKey),
      );
    } else if (mode === "line") {
      await options.tmuxService.sendKeySequence(
        target,
        buildTerminalLineSequence(data),
      );
    } else {
      await options.tmuxService.sendInput(target, dispatchData ?? "");
    }
  } else {
    if (!exitTmuxCopyMode) {
      ensured.runtime.write(
        codexSlashCommand
          ? buildCodexSlashCommandPtyInput(codexSlashCommand, composerSubmitKey)
          : mode === "prompt_paste"
            ? buildPromptPastePtyInput(data, composerSubmitKey)
          : (dispatchData ?? ""),
      );
    }
  }

  return {
    operationId: operationId ?? buildTerminalInputOperationId(),
    terminalSessionId: session.id,
    inputAccepted: true,
    inputEnqueued: true,
    runtimeKind: isTmuxBackedSession(session) ? "tmux" : "pty",
    acceptedAt: new Date().toISOString(),
  };
}
