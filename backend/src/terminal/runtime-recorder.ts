import { extractShellPromptMetadata } from "./shell-integration";
import type { TerminalSessionManager } from "./manager";

export function createTerminalRuntimeRecorder(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
) {
  return {
    onData(data: string) {
      const metadata = extractShellPromptMetadata(data);

      if (metadata.sessionName && metadata.cwd) {
        void terminalSessionManager.updateSessionMetadata(terminalSessionId, {
          name: metadata.sessionName,
          cwd: metadata.cwd,
        });
      }

      if (!metadata.output) {
        return;
      }

      terminalSessionManager.appendOutput(terminalSessionId, metadata.output);
    },
    onExit(event: { exitCode: number; signal?: number }) {
      terminalSessionManager.markExited(terminalSessionId, event.exitCode);
    },
  };
}
