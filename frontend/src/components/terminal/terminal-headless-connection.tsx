import { useCallback, useRef } from "react";
import {
  containsTerminalActivityContent,
  shouldEmitTerminalActivityPulse,
  shouldMarkTerminalActivity,
} from "../../features/terminal/activity-marker";
import { useTerminalConnection } from "../../features/terminal/use-terminal-connection";

interface TerminalHeadlessConnectionProps {
  apiBase: string;
  terminalSessionId: string;
  token: string;
  onAuthExpired?: () => void;
  onActivity?: () => void;
  onBell?: () => void;
  onMetadata?: (metadata: { name: string; cwd: string }) => void;
}

export function TerminalHeadlessConnection({
  apiBase,
  terminalSessionId,
  token,
  onAuthExpired,
  onActivity,
  onBell,
  onMetadata,
}: TerminalHeadlessConnectionProps) {
  const openedAtRef = useRef(Date.now());
  const lastActivityMarkedAtRef = useRef<number | null>(null);

  const handleOutput = useCallback(
    (data: string) => {
      const now = Date.now();
      if (data.includes("\u0007")) {
        onBell?.();
      }

      if (
        containsTerminalActivityContent(data) &&
        shouldMarkTerminalActivity({
          active: false,
          now,
          openedAt: openedAtRef.current,
          lastResizedAt: null,
        }) &&
        shouldEmitTerminalActivityPulse({
          now,
          lastMarkedAt: lastActivityMarkedAtRef.current,
        })
      ) {
        lastActivityMarkedAtRef.current = now;
        onActivity?.();
      }
    },
    [onActivity, onBell],
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
