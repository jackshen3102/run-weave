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
