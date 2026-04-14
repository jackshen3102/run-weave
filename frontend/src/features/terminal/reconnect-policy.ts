export const MIN_TERMINAL_RECONNECT_LIFETIME_MS = 1_000;
export const MAX_TERMINAL_RECONNECT_ATTEMPTS = 5;

const MAX_RECONNECT_DELAY_MS = 5_000;
const BASE_RECONNECT_DELAY_MS = 250;
const NON_RECONNECT_CLOSE_CODES = new Set([1000, 1008, 1011]);
const NON_RECONNECT_REASONS = new Set(["Terminal runtime not found"]);

export type TerminalReconnectRuntimeStatus = "running" | "exited" | null;

export function shouldAutoReconnectTerminalClose(params: {
  code: number;
  livedMs: number;
  reason?: string | null;
  reconnectAttempt?: number;
  terminalStatus?: TerminalReconnectRuntimeStatus;
}): boolean {
  if (params.terminalStatus === "exited") {
    return false;
  }

  if ((params.reconnectAttempt ?? 0) >= MAX_TERMINAL_RECONNECT_ATTEMPTS) {
    return false;
  }

  if (NON_RECONNECT_CLOSE_CODES.has(params.code)) {
    return false;
  }

  const reason = params.reason?.trim();
  if (reason && NON_RECONNECT_REASONS.has(reason)) {
    return false;
  }

  return params.livedMs >= MIN_TERMINAL_RECONNECT_LIFETIME_MS;
}

export function getTerminalReconnectDelay(attempt: number): number {
  return Math.min(
    BASE_RECONNECT_DELAY_MS * 2 ** Math.max(attempt, 0),
    MAX_RECONNECT_DELAY_MS,
  );
}
