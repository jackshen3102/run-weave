export interface CreateTerminalSessionRequest {
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

export interface CreateTerminalSessionResponse {
  terminalSessionId: string;
  terminalUrl: string;
}

export interface CreateTerminalWsTicketResponse {
  ticket: string;
  expiresIn: number;
}

export interface TerminalSessionStatusResponse {
  terminalSessionId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  scrollback: string;
  status: "running" | "exited";
  createdAt: string;
  exitCode?: number;
}

export interface TerminalSessionListItem {
  terminalSessionId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "exited";
  createdAt: string;
  exitCode?: number;
}

export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

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
