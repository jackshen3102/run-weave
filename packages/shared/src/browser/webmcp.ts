export interface BrowserTool {
  /** Opaque, document-local ID. Discover again after navigation/tool changes. */
  toolId: string;
  name: string;
  description: string;
  origin: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface BrowserToolList {
  supported: boolean;
  tools: BrowserTool[];
}

export interface BrowserToolCall {
  toolId: string;
  arguments: Record<string, unknown>;
}

export type BrowserToolErrorCode =
  | "WEBMCP_UNAVAILABLE"
  | "STALE_TOOL"
  | "INVALID_ARGUMENTS"
  | "UNSUPPORTED_SCHEMA"
  | "EXECUTION_UNKNOWN";

export interface BrowserToolFailure {
  ok: false;
  error: {
    code: BrowserToolErrorCode;
    message: string;
    execution: "not-started" | "unknown";
  };
}

export type BrowserToolResult<T> = { ok: true; value: T } | BrowserToolFailure;
