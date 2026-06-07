import type { TerminalMobileOverviewSession } from "@browser-viewer/shared";

import { formatRelativeTime } from "../lib/terminal-home-view-model";

interface TerminalRowProps {
  session: TerminalMobileOverviewSession;
}

export function TerminalRow({ session }: TerminalRowProps) {
  return (
    <article className="terminal-row">
      <div className="terminal-row__main">
        <div className="terminal-row__title-line">
          <h3>{session.title}</h3>
          <span className={`terminal-row__status is-${session.displayStatus}`}>
            {session.displayStatusLabel}
          </span>
        </div>
        <p>{session.subtitle}</p>
      </div>
      <time dateTime={session.lastActivityAt}>
        {formatRelativeTime(session.lastActivityAt)}
      </time>
    </article>
  );
}
