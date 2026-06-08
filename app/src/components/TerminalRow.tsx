import type { TerminalMobileOverviewSession } from "@browser-viewer/shared";

import { formatRelativeTime } from "../lib/terminal-home-view-model";

interface TerminalRowProps {
  session: TerminalMobileOverviewSession;
  onOpenTerminal: (terminalSessionId: string) => void;
}

export function TerminalRow({ session, onOpenTerminal }: TerminalRowProps) {
  return (
    <button
      className="terminal-row text-foreground"
      onClick={() => onOpenTerminal(session.terminalSessionId)}
      type="button"
    >
      <div className="terminal-row__main min-w-0">
        <div className="terminal-row__title-line min-w-0">
          <h3 className="text-foreground">{session.title}</h3>
          <span className={`terminal-row__status is-${session.displayStatus}`}>
            {session.displayStatusLabel}
          </span>
        </div>
        <p className="text-muted-foreground">{session.subtitle}</p>
      </div>
      <time className="text-muted-foreground" dateTime={session.lastActivityAt}>
        {formatRelativeTime(session.lastActivityAt)}
      </time>
    </button>
  );
}
