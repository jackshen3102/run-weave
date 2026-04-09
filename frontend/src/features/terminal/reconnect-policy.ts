const MIN_RECONNECT_LIFETIME_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 5_000;
const BASE_RECONNECT_DELAY_MS = 250;

export function shouldAutoReconnectTerminalClose(params: {
  code: number;
  livedMs: number;
}): boolean {
  return params.code !== 1008 && params.livedMs >= MIN_RECONNECT_LIFETIME_MS;
}

export function getTerminalReconnectDelay(attempt: number): number {
  return Math.min(
    BASE_RECONNECT_DELAY_MS * 2 ** Math.max(attempt, 0),
    MAX_RECONNECT_DELAY_MS,
  );
}
