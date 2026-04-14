import type { SessionListItem } from "@browser-viewer/shared";
import { SessionListItem as SessionCard } from "./session-list-item";

interface SessionListProps {
  sessions: SessionListItem[];
  loadingSessions: boolean;
  deletingSessionId: string | null;
  updatingAiPreferenceSessionId: string | null;
  actions?: "full" | "open-only";
  onRenameSession: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onToggleAiPreference: (sessionId: string, preferredForAi: boolean) => void;
}

export function SessionList({
  sessions,
  loadingSessions,
  deletingSessionId,
  updatingAiPreferenceSessionId,
  actions = "full",
  onRenameSession,
  onRemoveSession,
  onResumeSession,
  onToggleAiPreference,
}: SessionListProps) {
  if (loadingSessions && sessions.length === 0) {
    return (
      <div className="rounded-[1.25rem] border border-dashed border-border/60 px-5 py-6 text-sm text-muted-foreground">
        Loading sessions...
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="rounded-[1.25rem] border border-dashed border-border/60 px-5 py-6 text-sm text-muted-foreground">
        No sessions yet.
      </div>
    );
  }

  return (
    <>
      {sessions.map((session) => {
        const isDeleting = deletingSessionId === session.sessionId;
        const isUpdatingAiPreference =
          updatingAiPreferenceSessionId === session.sessionId;

        return (
          <SessionCard
            key={session.sessionId}
            session={session}
            isDeleting={isDeleting}
            isUpdatingAiPreference={isUpdatingAiPreference}
            actions={actions}
            onRename={() => onRenameSession(session.sessionId)}
            onRemove={() => onRemoveSession(session.sessionId)}
            onResume={() => onResumeSession(session.sessionId)}
            onToggleAiPreference={() =>
              onToggleAiPreference(session.sessionId, !session.preferredForAi)
            }
          />
        );
      })}
    </>
  );
}
