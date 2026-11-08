import type { EnvironmentContext } from "../configuration";
import type { TerminalOutputCursor, TerminalOutputRange } from "./runtime/websocket";

export const PTY_HOST_PROTOCOL_VERSION = 1;
export interface PtyHostBinding {
  hostInstanceId: string;
  sessionInstanceId: string;
}
export interface PtyHostDescriptor {
  protocolVersion: number;
  hostInstanceId: string;
  pid: number;
  startedAt: string;
  scope: EnvironmentContext;
  endpoint: string;
  gatewayUrl: string;
  release: string;
}
export interface PtyHostSession extends PtyHostBinding {
  terminalSessionId: string;
  pid: number;
  projectId: string;
  status: "running" | "exited";
  exitCode?: number;
  cols: number;
  rows: number;
  gatewayToken: string;
  nextSequence: number;
}
export type PtyHostInputStep = { type: "text"; data: string } | { type: "delay"; ms: number };
export interface PtyHostInput {
  operationId: string;
  sequence: number;
  steps: PtyHostInputStep[];
}
export interface PtyHostInputResult {
  operationId: string;
  sequence: number;
  state: "accepted" | "written" | "failed" | "uncertain";
  error?: string;
}
export interface PtyHostCreateSession {
  sessionInstanceId: string;
  terminalSessionId: string;
  projectId: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string | undefined>;
}
export interface PtyHostSnapshot {
  data: string;
  cursor: TerminalOutputCursor;
  cols: number;
  rows: number;
}
export interface PtyHostTarget extends PtyHostBinding {
  terminalSessionId: string;
  generation: number;
}
export interface PtyHostUpstreams {
  backendUrl: string;
  backendToken: string;
  appServerUrl: string;
  appServerToken: string;
}
export interface PtyHostWireRequest {
  requestId: string;
  token: string;
  hostInstanceId: string;
  action: string;
  body: unknown;
}
export type PtyHostEvent =
  | { type: "output"; terminalSessionId: string; data: string; cursor: TerminalOutputCursor; range: TerminalOutputRange }
  | { type: "exit"; terminalSessionId: string; exitCode: number }
  | { type: "gap"; terminalSessionId: string };
