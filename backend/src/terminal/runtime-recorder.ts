import { createShellPromptTracker } from "./shell-integration";
import type { TerminalSessionManager } from "./manager";

export function createTerminalRuntimeRecorder(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
) {
  const tracker = createShellPromptTracker({
    cwd: terminalSessionManager.getSession(terminalSessionId)?.cwd ?? null,
    activeCommand:
      terminalSessionManager.getSession(terminalSessionId)?.activeCommand ?? null,
  });

  return {
    onData(data: string) {
      const metadata = tracker.consume(data);

      if (metadata.metadataChanged && metadata.cwd) {
        void terminalSessionManager.updateSessionMetadata(terminalSessionId, {
          cwd: metadata.cwd,
          activeCommand: metadata.activeCommand,
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
