import type { SessionListItem } from "@browser-viewer/shared";
import { RefreshCw } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { SessionList } from "./session-list";

interface SessionDrawerProps {
  isOpen: boolean;
  loadingSessions: boolean;
  sessions: SessionListItem[];
  deletingSessionId: string | null;
  activeSessionMenuId: string | null;
  onClose: () => void;
  onToggleMenu: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
}

export function SessionDrawer({
  isOpen,
  loadingSessions,
  sessions,
  deletingSessionId,
  activeSessionMenuId,
  onClose,
  onToggleMenu,
  onRemoveSession,
  onResumeSession,
}: SessionDrawerProps) {
  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/16 transition-opacity ${
          isOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border/60 bg-background/94 px-5 py-6 shadow-2xl backdrop-blur-xl transition-transform duration-300 sm:px-6 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        } ${isOpen ? "animate-panel-in" : ""}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
              Sessions
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-foreground">
              Quiet history.
            </h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full px-4"
            onClick={onClose}
          >
            Close
          </Button>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{loadingSessions ? "Refreshing quietly..." : `${sessions.length} total`}</span>
          <span className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground/55">
            <RefreshCw
              className={`h-3.5 w-3.5 ${loadingSessions ? "animate-spin" : ""}`}
            />
            Synced
          </span>
        </div>

        <div className="mt-6 flex-1 space-y-3 overflow-y-auto pr-1">
          <SessionList
            sessions={sessions}
            deletingSessionId={deletingSessionId}
            activeSessionMenuId={activeSessionMenuId}
            onToggleMenu={onToggleMenu}
            onRemoveSession={onRemoveSession}
            onResumeSession={onResumeSession}
          />
        </div>
      </aside>
    </>
  );
}
