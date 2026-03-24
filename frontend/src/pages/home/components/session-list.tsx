import type { SessionListItem } from "@browser-viewer/shared";
import { SessionListItem as SessionCard } from "./session-list-item";

interface SessionListProps {
  sessions: SessionListItem[];
  deletingSessionId: string | null;
  activeSessionMenuId: string | null;
  onToggleMenu: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
}

export function SessionList({
  sessions,
  deletingSessionId,
  activeSessionMenuId,
  onToggleMenu,
  onRemoveSession,
  onResumeSession,
}: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-[1.5rem] border border-dashed border-border/60 px-5 py-6 text-sm text-muted-foreground">
        No other sessions.
      </div>
    );
  }

  return (
    <>
      {sessions.map((session) => {
        const isDeleting = deletingSessionId === session.sessionId;
        const isMenuOpen = activeSessionMenuId === session.sessionId;

        return (
          <SessionCard
            key={session.sessionId}
            session={session}
            isDeleting={isDeleting}
            isMenuOpen={isMenuOpen}
            onToggleMenu={() => onToggleMenu(session.sessionId)}
            onRemove={() => onRemoveSession(session.sessionId)}
            onResume={() => onResumeSession(session.sessionId)}
          />
        );
      })}
    </>
  );
}
