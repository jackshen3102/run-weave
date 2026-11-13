/** Only recoverable output connection failures may reconnect with a fresh snapshot. */
export function isTerminalOutputRecoveryClose(code: number, reason?: string | null): boolean {
  return code === 1013 && [
    "Terminal output recovery required", // Compatibility with older Backends.
    // A lost pipe does not prove loss of the Host or its PTY. Reattach by the
    // existing Host/session binding; writer and identity conflicts still stop.
    "Terminal host connection lost",
    "Terminal initial output queue exceeded",
    "Terminal recovery queue exceeded",
    "Terminal recovery unavailable; reconnect",
  ].includes(reason?.trim() ?? "");
}

export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface TerminalModeState {
  bracketedPasteMode: boolean | null;
}

/** A committed position in one tmux attach display stream (UTF-8 bytes). */
export interface TerminalOutputCursor {
  streamId: string;
  offset: number;
}

export interface TerminalOutputRange {
  streamId: string;
  fromOffset: number;
  toOffset: number;
}

export type TerminalRecoveryReason =
  | "initial"
  | "cursor_valid"
  | "cursor_missing"
  | "client_lease_missing"
  | "client_lease_expired"
  | "stream_changed"
  | "cursor_invalid"
  | "cursor_expired"
  | "cursor_evicted";

export interface TerminalOutputRecovery {
  mode: "snapshot" | "resume";
  reason: TerminalRecoveryReason;
}

export type TerminalClientMessage =
  | {
      type: "input";
      data: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "signal";
      signal: TerminalSignal;
    }
  | {
      type: "request-status";
    };

export type TerminalServerMessage =
  | {
      type: "connected";
      terminalSessionId: string;
      runtimeKind?: "tmux" | "pty";
      /** Ctrl-wheel (SGR 80/81) moves one row; ordinary wheel remains five rows. */
      tmuxScrollMode?: "single-row";
      /** Opt-in grid changes are fenced by the display stream cursor. */
      resizeMode?: "ordered";
      recovery?: TerminalOutputRecovery;
    }
  | {
      type: "snapshot";
      data: string;
      modes?: TerminalModeState;
      cursor?: TerminalOutputCursor;
      cols?: number;
      rows?: number;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
      cursor: TerminalOutputCursor;
    }
  | {
      type: "metadata";
      cwd: string;
      activeCommand: string | null;
    }
  | {
      type: "output";
      data: string;
      range?: TerminalOutputRange;
    }
  | {
      type: "status";
      status: "running" | "exited";
      exitCode?: number;
    }
  | {
      type: "exit";
      exitCode: number | null;
    }
  | {
      type: "notice";
      message: string;
    }
  | {
      type: "error";
      message: string;
    };
