/** Native App only: one authenticated WebSocket carries one local TCP stream. */
export const LOCAL_BROWSER_PROTOCOL = 1;
export const LOCAL_BROWSER_MAX_FRAME = 64 * 1024;
export const LOCAL_BROWSER_MAX_BUFFER = 1024 * 1024;
export const LOCAL_BROWSER_MAX_CONNECTIONS = 32;
export interface LocalBrowserCapabilities {
  protocolVersion: 1;
  maxConnections: number;
  maxFrameBytes: number;
}
export interface LocalBrowserOpen {
  type: "open";
  version: 1;
  terminalSessionId: string;
  browserSessionId: string;
  host: string;
  port: number;
  secure: boolean;
}
export type LocalBrowserError =
  | "unsupported_version"
  | "invalid_target"
  | "unauthorized"
  | "source_unavailable"
  | "target_unavailable"
  | "connect_timeout"
  | "connection_limit"
  | "protocol_error"
  | "buffer_limit";
export type LocalBrowserControl =
  | { type: "ready" }
  | { type: "eof" }
  | { type: "error"; code: LocalBrowserError };
