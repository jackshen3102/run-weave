import { useCallback, useEffect, useMemo, useState } from "react";
import type { TerminalSessionListItem } from "@browser-viewer/shared";
import { Plus, X } from "lucide-react";
import { HttpError } from "../../services/http";
import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
} from "../../services/terminal";
import { Button } from "../ui/button";
import { TerminalSurface } from "./terminal-surface";

interface TerminalWorkspaceProps {
  apiBase: string;
  token: string;
  linkedBrowserSessionId?: string;
  initialTerminalSessionId?: string;
  onAuthExpired?: () => void;
  className?: string;
}

const AUTO_CREATE_IN_FLIGHT_BY_BROWSER_SESSION = new Set<string>();
const AUTO_CREATE_DONE_BY_BROWSER_SESSION = new Set<string>();

function buildSessionLabel(session: TerminalSessionListItem): string {
  const renderedArgs = session.args.join(" ");
  return renderedArgs ? `${session.command} ${renderedArgs}` : session.command;
}

export function TerminalWorkspace({
  apiBase,
  token,
  linkedBrowserSessionId,
  initialTerminalSessionId,
  onAuthExpired,
  className,
}: TerminalWorkspaceProps) {
  const [sessions, setSessions] = useState<TerminalSessionListItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    initialTerminalSessionId ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const visibleSessions = useMemo(() => {
    const filtered = linkedBrowserSessionId
      ? sessions.filter(
          (session) => session.linkedBrowserSessionId === linkedBrowserSessionId,
        )
      : sessions;

    return filtered.sort((left, right) => {
      return (
        new Date(right.lastActivityAt).getTime() -
        new Date(left.lastActivityAt).getTime()
      );
    });
  }, [linkedBrowserSessionId, sessions]);

  const activeSession =
    visibleSessions.find((session) => session.terminalSessionId === activeSessionId) ??
    visibleSessions[0] ??
    null;

  const loadSessions = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const nextSessions = await listTerminalSessions(apiBase, token);
      setSessions(nextSessions);
      if (!activeSessionId) {
        setActiveSessionId(nextSessions[0]?.terminalSessionId ?? null);
      }
      setRequestError(null);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
        return;
      }
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, apiBase, onAuthExpired, token]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (
      activeSessionId &&
      visibleSessions.some(
        (session) => session.terminalSessionId === activeSessionId,
      )
    ) {
      return;
    }

    setActiveSessionId(visibleSessions[0]?.terminalSessionId ?? null);
  }, [activeSessionId, visibleSessions]);

  const createSession = useCallback(async (options?: { autoCreateBrowserSessionId?: string }): Promise<void> => {
    setLoading(true);
    const autoCreateBrowserSessionId = options?.autoCreateBrowserSessionId;
    try {
      const created = await createTerminalSession(apiBase, token, {
        linkedBrowserSessionId,
      });
      if (autoCreateBrowserSessionId) {
        AUTO_CREATE_DONE_BY_BROWSER_SESSION.add(autoCreateBrowserSessionId);
      }
      setRequestError(null);
      await loadSessions();
      setActiveSessionId(created.terminalSessionId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
        return;
      }
      setRequestError(String(error));
    } finally {
      if (autoCreateBrowserSessionId) {
        AUTO_CREATE_IN_FLIGHT_BY_BROWSER_SESSION.delete(autoCreateBrowserSessionId);
      }
      setLoading(false);
    }
  }, [apiBase, linkedBrowserSessionId, loadSessions, onAuthExpired, token]);

  useEffect(() => {
    if (!linkedBrowserSessionId) {
      return;
    }
    if (loading || visibleSessions.length > 0) {
      return;
    }
    if (
      AUTO_CREATE_DONE_BY_BROWSER_SESSION.has(linkedBrowserSessionId) ||
      AUTO_CREATE_IN_FLIGHT_BY_BROWSER_SESSION.has(linkedBrowserSessionId)
    ) {
      return;
    }

    AUTO_CREATE_IN_FLIGHT_BY_BROWSER_SESSION.add(linkedBrowserSessionId);
    void createSession({
      autoCreateBrowserSessionId: linkedBrowserSessionId,
    });
  }, [createSession, linkedBrowserSessionId, loading, visibleSessions.length]);

  const closeSession = async (terminalSessionId: string): Promise<void> => {
    setLoading(true);
    try {
      await deleteTerminalSession(apiBase, token, terminalSessionId);
      setRequestError(null);
      await loadSessions();
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
        return;
      }
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      className={[
        "flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-950",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="border-b border-slate-800/90 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleSessions.map((session) => {
              const isActive =
                session.terminalSessionId === activeSession?.terminalSessionId;
              return (
                <div
                  key={session.terminalSessionId}
                  className="flex items-center gap-1 rounded-full border border-slate-700/80 bg-slate-900/60 px-2 py-1"
                >
                  <button
                    type="button"
                    className={`max-w-[220px] truncate rounded-full px-2 py-0.5 text-xs ${
                      isActive ? "bg-slate-100 text-slate-900" : "text-slate-300"
                    }`}
                    onClick={() => {
                      setActiveSessionId(session.terminalSessionId);
                    }}
                    title={buildSessionLabel(session)}
                  >
                    {session.name}
                  </button>
                  <button
                    type="button"
                    className="rounded-full p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                    aria-label={`Close terminal ${session.name}`}
                    onClick={() => {
                      void closeSession(session.terminalSessionId);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <Button
            type="button"
            size="sm"
            disabled={loading}
            className="h-9 shrink-0 rounded-full px-4"
            onClick={() => {
              void createSession();
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            New
          </Button>
        </div>

        {requestError ? (
          <p className="mt-2 text-xs text-rose-400">{requestError}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {activeSession ? (
          <TerminalSurface
            key={activeSession.terminalSessionId}
            apiBase={apiBase}
            terminalSessionId={activeSession.terminalSessionId}
            token={token}
            onAuthExpired={onAuthExpired}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-sm text-slate-400">
            No terminal tab yet. Create one to start.
          </div>
        )}
      </div>
    </section>
  );
}
