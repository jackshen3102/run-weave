export const BELL_CHARACTER = "\u0007";
export const TERMINAL_RESIZE_DEBOUNCE_MS = 120;
export const DEFERRED_OUTPUT_REPLAY_MAX_CHARS = 128 * 1024;
export const IME_COMMIT_DUPLICATE_WINDOW_MS = 250;
export const IME_COMMIT_WINDOW_MS = 250;

export interface PastedImageReference {
  id: string;
  label: string;
  filePath: string;
}

export interface TerminalSearchResults {
  resultCount: number;
  resultIndex: number;
}

export interface TerminalSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export type SearchDirection = "next" | "previous";

export function recordTerminalPerfProbeEvent(
  event: string,
  data: string,
  details: Record<string, unknown>,
): void {
  const target = window as unknown as {
    __terminalPerfProbeEvents?: Array<{
      event: string;
      at: number;
      details: Record<string, unknown>;
    }>;
  };
  if (!target.__terminalPerfProbeEvents) {
    return;
  }

  const probeText = data.match(/BV_[^\s\r\n]+/)?.[0];
  if (!probeText) {
    return;
  }

  target.__terminalPerfProbeEvents.push({
    event,
    at: performance.now(),
    details: {
      ...details,
      probeText,
    },
  });
}

export function resolveMobileBeforeInputData(
  event: InputEvent,
  helperTextarea: HTMLTextAreaElement,
): string | null {
  if (
    event.inputType === "insertText" ||
    event.inputType === "insertReplacementText" ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromPaste"
  ) {
    return (event.data ?? helperTextarea.value) || null;
  }

  if (
    event.inputType === "insertLineBreak" ||
    event.inputType === "insertParagraph"
  ) {
    return "\r";
  }

  if (event.inputType === "deleteContentBackward") {
    return "\u007f";
  }

  if (event.inputType === "deleteContentForward") {
    return "\u001b[3~";
  }

  return null;
}

export function hasNonAsciiInput(data: string): boolean {
  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) > 0x7f) {
      return true;
    }
  }
  return false;
}
