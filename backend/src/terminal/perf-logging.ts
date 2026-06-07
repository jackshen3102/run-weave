import { logger } from "../logging";

const terminalPerfLogger = logger.child({ component: "terminal-perf" });

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

  terminalPerfLogger.info("terminal.perf", {
    message: "Terminal performance event",
    perfEvent: event,
    at: new Date().toISOString(),
    ...details,
  });
}
