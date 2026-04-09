import { createShellPromptTracker } from "./shell-integration";
import type { TerminalSessionManager } from "./manager";

export function createTerminalRuntimeRecorder(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
) {
  const tracker = createShellPromptTracker({
    cwd: terminalSessionManager.getSession(terminalSessionId)?.cwd ?? null,
  });

  return {
    onData(data: string) {
      const metadata = tracker.consume(data);

      if (metadata.metadataChanged && metadata.sessionName && metadata.cwd) {
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
