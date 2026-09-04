const TERMINAL_PERF_LOG_PREFIX = "[terminal-perf-fe]";
const TERMINAL_PERF_LOG_STORAGE_KEY = "viewer.terminal.perfLogs";

function isTerminalPerfLoggingEnabled(): boolean {
  if (import.meta.env.VITE_TERMINAL_PERF_LOGS === "true") {
    return true;
  }

  try {
    return localStorage.getItem(TERMINAL_PERF_LOG_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
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
