import type {
  TerminalBrowserErrorCode,
  TerminalBrowserErrorPayload,
} from "@runweave/shared/terminal-browser-profile";

export class TerminalBrowserError extends Error {
  readonly code: TerminalBrowserErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: TerminalBrowserErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "TerminalBrowserError";
    this.code = code;
    this.details = details;
  }

  toPayload(): TerminalBrowserErrorPayload {
    return {
      code: this.code,
      message: this.message.replace(`${this.code}: `, ""),
      details: this.details,
    };
  }
}

export function toTerminalBrowserErrorPayload(
  error: unknown,
  fallbackCode: TerminalBrowserErrorCode,
): TerminalBrowserErrorPayload {
  if (error instanceof TerminalBrowserError) {
    return error.toPayload();
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}
