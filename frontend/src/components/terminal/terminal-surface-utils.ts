export const BELL_CHARACTER = "\u0007";
export const TERMINAL_RESIZE_DEBOUNCE_MS = 120;
export const DEFERRED_OUTPUT_REPLAY_MAX_CHARS = 128 * 1024;
export const IME_COMMIT_DUPLICATE_WINDOW_MS = 50;
export const IME_COMMIT_WINDOW_MS = 250;

const ESCAPE = "\\u001b";
const BELL = "\\u0007";
const OSC_COLOR_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\]1[01];rgb:[0-9a-f/]+(?:${BELL}|${ESCAPE}\\\\)`,
  "i",
);
const DECRPM_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[\\?[0-9;]+\\$y`);
const DCS_RESPONSE_PATTERN = new RegExp(`${ESCAPE}P[01]\\$r.*${ESCAPE}\\\\`);
const CURSOR_POSITION_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]+R`);
const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\[(?:\\?|>)[0-9;]+c`,
);
const FOCUS_REPORTING_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[(?:I|O)$`);

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

export function isTerminalAutoResponse(data: string): boolean {
  if (!data.startsWith("\u001b")) {
    return false;
  }

  return (
    OSC_COLOR_RESPONSE_PATTERN.test(data) ||
    DECRPM_RESPONSE_PATTERN.test(data) ||
    DCS_RESPONSE_PATTERN.test(data) ||
    CURSOR_POSITION_RESPONSE_PATTERN.test(data) ||
    DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data) ||
    FOCUS_REPORTING_RESPONSE_PATTERN.test(data)
  );
}

export function isShiftEnterLineFeed(event: KeyboardEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

export async function fileToBase64(file: File): Promise<string> {
  if (typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer();
    return btoa(
      Array.from(new Uint8Array(buffer), (byte) =>
        String.fromCharCode(byte),
      ).join(""),
    );
  }

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read clipboard image"));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read clipboard image"));
        return;
      }
      resolve(result.split(",", 2)[1] ?? "");
    };
    reader.readAsDataURL(file);
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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
