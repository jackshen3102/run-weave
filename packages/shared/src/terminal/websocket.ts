export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface TerminalModeState {
  bracketedPasteMode: boolean | null;
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
    }
  | {
      type: "snapshot";
      data: string;
      modes?: TerminalModeState;
    }
  | {
      type: "metadata";
      cwd: string;
      activeCommand: string | null;
    }
  | {
      type: "output";
      data: string;
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
      type: "error";
      message: string;
    };
