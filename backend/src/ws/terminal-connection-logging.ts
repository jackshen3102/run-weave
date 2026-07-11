import { logger } from "../logging";
import { logTerminalPerf } from "../terminal/perf-logging";

const terminalWsLogger = logger.child({ component: "terminal-ws" });

export function logTerminalConnectionOpened(input: {
  clientId: string;
  runtimeExists: boolean;
  runtimeKind: "tmux" | "pty";
  sessionStatus: string | null;
  terminalSessionId: string;
}): void {
  logTerminalPerf("terminal.ws.connected", input);
  terminalWsLogger.info("terminal-ws.connected", {
    message: "Terminal websocket connected",
    ...input,
  });
}
