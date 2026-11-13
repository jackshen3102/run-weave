/** Diagnostics contain identifiers and counters only, never RPC bodies or terminal text. */
export interface HostDiagnostic {
  event: "pty-host.connection.closed" | "pty-host.request.failed" | "pty-host.mirror.failed";
  hostInstanceId: string;
  connectionId?: string;
  terminalSessionId?: string;
  requestId?: string;
  action?: string;
  code: string;
  elapsedMs?: number;
  pendingRequests?: number;
  writableBytes?: number;
  bufferedBytes?: number;
  limitBytes?: number;
  queuedOperations?: number;
}

export type HostDiagnosticSink = (diagnostic: HostDiagnostic) => void;

export function hostErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "HOST_OPERATION_FAILED";
  const code = (error as NodeJS.ErrnoException).code;
  if (code && /^(?:E[A-Z0-9_]+|HOST_[A-Z0-9_]+)$/.test(code)) return code;
  return /^HOST_[A-Z0-9_]+$/.test(error.message) ? error.message : "HOST_OPERATION_FAILED";
}

const actions = new Set(["hello", "claimWriter", "listSessions", "createSession", "setUpstreams", "freeze", "stop",
  "writeInput", "getInputOperation", "getSnapshot", "readOutput", "resize", "signal", "closeSession", "attachSession"]);

export function diagnosticAction(action: string): string {
  return actions.has(action) ? action : "unknown";
}

export function writeHostDiagnostic(diagnostic: HostDiagnostic): void {
  process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), ...diagnostic }) + "\n");
}

export function reportHostDiagnostic(sink: HostDiagnosticSink, diagnostic: HostDiagnostic): void {
  // A diagnostic sink must never interrupt socket cleanup or request settlement.
  try { sink(diagnostic); } catch { /* Best effort. */ }
}
