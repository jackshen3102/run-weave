import { useCallback } from "react";
import { useTerminalConnection } from "../../features/terminal/use-terminal-connection";

interface TerminalHeadlessConnectionProps {
  apiBase: string;
  terminalSessionId: string;
  token: string;
  onAuthExpired?: () => void;
  onBell?: () => void;
  onMetadata?: (metadata: { cwd: string; activeCommand: string | null }) => void;
}

export function TerminalHeadlessConnection({
  apiBase,
  terminalSessionId,
  token,
  onAuthExpired,
  onBell,
  onMetadata,
}: TerminalHeadlessConnectionProps) {
  const handleOutput = useCallback(
    (data: string) => {
      if (data.includes("\u0007")) {
        onBell?.();
      }
    },
    [onBell],
  );

  useTerminalConnection({
    apiBase,
    terminalSessionId,
    token,
    onAuthExpired,
    onOutput: handleOutput,
    onMetadata,
    includeSnapshot: false,
  });

  return null;
}
