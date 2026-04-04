export interface CreateTerminalSessionRequest {
  projectId?: string;
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

export interface CreateTerminalProjectRequest {
  name: string;
}

export interface UpdateTerminalProjectRequest {
  name: string;
}

export interface TerminalProjectListItem {
  projectId: string;
  name: string;
  createdAt: string;
  isDefault: boolean;
}

export interface CreateTerminalSessionResponse {
  terminalSessionId: string;
  terminalUrl: string;
}

export interface CreateTerminalWsTicketResponse {
  ticket: string;
  expiresIn: number;
}

export interface CreateTerminalClipboardImageRequest {
  mimeType: string;
  dataBase64: string;
}

export interface CreateTerminalClipboardImageResponse {
  fileName: string;
  filePath: string;
}

export interface TerminalSessionStatusResponse {
  terminalSessionId: string;
  projectId: string;
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
  projectId: string;
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
      type: "metadata";
      name: string;
      cwd: string;
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
