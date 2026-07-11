import type { TerminalState, TerminalStateValue } from "@runweave/shared/terminal/state";
import type { ClientMode } from "../client-mode";

export const TERMINAL_FLOATING_COMPOSER_SHOW_ROWS = 8;
export const TERMINAL_FLOATING_COMPOSER_HIDE_ROWS = 2;

const SUPPORTED_AGENT_COMMANDS = new Set([
  "codex",
  "trae",
  "traex",
  "traecli",
  "claude",
]);

const SUPPORTED_TERMINAL_AGENT_STATES = new Set<TerminalStateValue>([
  "agent_starting",
  "agent_idle",
  "agent_running",
]);
const ESCAPE = "\u001b";
const TERMINAL_FOCUS_REPORT_INPUTS = new Set([
  `${ESCAPE}[I`,
  `${ESCAPE}[O`,
]);
const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
const BRACKETED_PASTE_END = `${ESCAPE}[201~`;
const SGR_MOUSE_INPUT_RE = new RegExp(
  `^${ESCAPE}\\[<\\d+;\\d+;\\d+[mM]$`,
);
const SGR_MOUSE_INPUT_PREFIX_RE = new RegExp(
  `^${ESCAPE}\\[<\\d+;\\d+;\\d+[mM]`,
);
const X10_MOUSE_INPUT_RE = new RegExp(`^${ESCAPE}\\[M[\\s\\S]{3}$`);
const X10_MOUSE_INPUT_PREFIX_RE = new RegExp(`^${ESCAPE}\\[M[\\s\\S]{3}`);

function commandBasename(command: string | null): string | null {
  const firstToken = command?.trim().split(/\s+/)[0];
  if (!firstToken) {
    return null;
  }

  const basename = firstToken.split(/[\\/]/).pop()?.toLowerCase();
  return basename || null;
}

function isNonEditingTerminalControlInput(data: string): boolean {
  return (
    TERMINAL_FOCUS_REPORT_INPUTS.has(data) ||
    SGR_MOUSE_INPUT_RE.test(data) ||
    X10_MOUSE_INPUT_RE.test(data)
  );
}

function consumeNonEditingTerminalControlInput(
  data: string,
  index: number,
): number | null {
  for (const input of TERMINAL_FOCUS_REPORT_INPUTS) {
    if (data.startsWith(input, index)) {
      return index + input.length;
    }
  }

  const remaining = data.slice(index);
  const sgrMouseInput = SGR_MOUSE_INPUT_PREFIX_RE.exec(remaining);
  if (sgrMouseInput) {
    return index + sgrMouseInput[0].length;
  }

  const x10MouseInput = X10_MOUSE_INPUT_PREFIX_RE.exec(remaining);
  if (x10MouseInput) {
    return index + x10MouseInput[0].length;
  }

  return null;
}

function stripNonEditingTerminalControlInputs(data: string): string {
  let nextData = "";
  let index = 0;

  while (index < data.length) {
    const nextIndex = consumeNonEditingTerminalControlInput(data, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    nextData += data[index];
    index += 1;
  }

  return nextData;
}

function applyPrintableDraftText(
  draft: string,
  text: string,
): { draft: string; supported: boolean } {
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      codePoint < 32 &&
      char !== "\n" &&
      char !== "\r"
    ) {
      return { draft, supported: false };
    }
  }

  return {
    draft: `${draft}${text.replace(/\r\n?/g, "\n")}`,
    supported: true,
  };
}

export function isSupportedFloatingComposerAgent(params: {
  activeCommand: string | null;
  terminalState?: TerminalState;
}): boolean {
  const { terminalState } = params;
  const terminalAgent = terminalState?.agent;
  if (
    terminalAgent &&
    SUPPORTED_AGENT_COMMANDS.has(terminalAgent) &&
    SUPPORTED_TERMINAL_AGENT_STATES.has(terminalState.state)
  ) {
    return true;
  }

  const basename = commandBasename(params.activeCommand);
  return basename !== null && SUPPORTED_AGENT_COMMANDS.has(basename);
}

export function shouldEnableFloatingComposer(params: {
  clientMode: ClientMode;
  activeCommand: string | null;
  terminalState?: TerminalState;
  bufferType: "normal" | "alternate" | undefined;
  searchOpen: boolean;
  sessionRunning: boolean;
}): boolean {
  const supportedAgent = isSupportedFloatingComposerAgent({
    activeCommand: params.activeCommand,
    terminalState: params.terminalState,
  });
  const hasTuiSignal = params.bufferType === "alternate" || supportedAgent;

  return (
    params.clientMode === "desktop" &&
    !params.searchOpen &&
    params.sessionRunning &&
    supportedAgent &&
    hasTuiSignal
  );
}

export function applyTerminalDraftInput(
  draft: string,
  data: string,
): { draft: string; supported: boolean } {
  if (!data) {
    return { draft, supported: true };
  }

  const normalizedData = stripNonEditingTerminalControlInputs(data);
  if (!normalizedData) {
    return { draft, supported: true };
  }

  if (
    normalizedData.startsWith(BRACKETED_PASTE_START) &&
    normalizedData.endsWith(BRACKETED_PASTE_END)
  ) {
    return applyPrintableDraftText(
      draft,
      normalizedData.slice(
        BRACKETED_PASTE_START.length,
        -BRACKETED_PASTE_END.length,
      ),
    );
  }

  data = normalizedData;

  if (data === "\r") {
    return { draft: "", supported: true };
  }

  if (data === "\n") {
    return { draft: `${draft}\n`, supported: true };
  }

  if (data === "\x15") {
    return { draft: "", supported: true };
  }

  if (data === "\x7f" || data === "\b") {
    const codePoints = Array.from(draft);
    codePoints.pop();
    return { draft: codePoints.join(""), supported: true };
  }

  if (isNonEditingTerminalControlInput(data)) {
    return { draft, supported: true };
  }

  if (data.startsWith("\x1b")) {
    return { draft, supported: false };
  }

  return applyPrintableDraftText(draft, data);
}
