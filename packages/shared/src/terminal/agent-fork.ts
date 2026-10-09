export interface TerminalAgentForkTarget {
  panelId: string;
  threadId: string;
  cwd: string;
  revision: string;
}

export interface ForkTerminalAgentRequest {
  operationId: string;
  panelId: string;
  expectedThreadId: string;
  expectedRevision: string;
}

export interface ForkTerminalAgentResponse {
  terminalSessionId: string;
  panelId: string;
  threadId: string;
  sourceThreadId: string;
  status: "starting";
}
