const TERMINAL_PERF_LOG_PREFIX = "[terminal-perf-be]";

function isTerminalPerfLoggingEnabled(): boolean {
  return process.env.TERMINAL_PERF_LOGS === "true";
}

export function summarizeTerminalChunk(data: string): { len: number; preview: string } {
  return {
    len: data.length,
    preview: JSON.stringify(data.slice(0, 32)),
  };
}

export function logTerminalPerf(
  event: string,
  details: Record<string, unknown>,
): void {
  if (!isTerminalPerfLoggingEnabled()) {
    return;
  }

  console.info(TERMINAL_PERF_LOG_PREFIX, event, {
    at: new Date().toISOString(),
    ...details,
  });
}
