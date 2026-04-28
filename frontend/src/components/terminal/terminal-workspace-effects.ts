import { useEffect } from "react";
import type { TerminalSessionListItem } from "@browser-viewer/shared";
import {
  loadRecentTerminalSelection,
  saveRecentTerminalSelection,
} from "../../features/terminal/recent-selection";

export function resolvePreferredSessionId(
  apiBase: string,
  projectId: string,
  projectSessions: TerminalSessionListItem[],
  preferredSessionId?: string | null,
): string | null {
  if (preferredSessionId) {
    const matchingPreferredSession = projectSessions.find(
      (session) => session.terminalSessionId === preferredSessionId,
    );
    if (matchingPreferredSession) {
      return matchingPreferredSession.terminalSessionId;
    }
  }

  const recentSelection = loadRecentTerminalSelection(apiBase);
  const recentProjectSessionId =
    recentSelection?.projectSessionIds[projectId] ?? recentSelection?.terminalSessionId;
  if (recentProjectSessionId) {
    const matchingRecentSession = projectSessions.find(
      (session) => session.terminalSessionId === recentProjectSessionId,
    );
    if (matchingRecentSession) {
      return matchingRecentSession.terminalSessionId;
    }
  }

  return projectSessions[0]?.terminalSessionId ?? null;
}

function cycleIndex(currentIndex: number, total: number, delta: number): number {
  if (total <= 0) {
    return -1;
  }

  const normalizedCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  return (normalizedCurrentIndex + delta + total) % total;
}

interface SessionSelectionShortcutOptions {
  enabled: boolean;
  activeProjectId: string | null;
  activeSessionId: string | null;
  visibleProjects: Array<{ projectId: string }>;
  visibleSessions: TerminalSessionListItem[];
  onSelectProject: (projectId: string) => void;
  onSelectSession: (terminalSessionId: string) => void;
}

export function useSessionSelectionShortcuts({
  enabled,
  activeProjectId,
  activeSessionId,
  visibleProjects,
  visibleSessions,
  onSelectProject,
  onSelectSession,
}: SessionSelectionShortcutOptions): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const matchesPrevious = event.code === "BracketLeft" || event.key === "[";
      const matchesNext = event.code === "BracketRight" || event.key === "]";
      const isPreviousProject = !event.shiftKey && matchesPrevious;
      const isNextProject = !event.shiftKey && matchesNext;
      const isPreviousSession = event.shiftKey && matchesPrevious;
      const isNextSession = event.shiftKey && matchesNext;

      if (!isPreviousProject && !isNextProject && !isPreviousSession && !isNextSession) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (isPreviousProject || isNextProject) {
        if (visibleProjects.length <= 1) {
          return;
        }

        const currentProjectIndex = visibleProjects.findIndex(
          (project) => project.projectId === activeProjectId,
        );
        const nextProject = visibleProjects[
          cycleIndex(
            currentProjectIndex,
            visibleProjects.length,
            isPreviousProject ? -1 : 1,
          )
        ];
        if (nextProject) {
          onSelectProject(nextProject.projectId);
        }
        return;
      }

      if (visibleSessions.length <= 1) {
        return;
      }

      const currentSessionIndex = visibleSessions.findIndex(
        (session) => session.terminalSessionId === activeSessionId,
      );
      const nextSession = visibleSessions[
        cycleIndex(
          currentSessionIndex,
          visibleSessions.length,
          isPreviousSession ? -1 : 1,
        )
      ];
      if (nextSession) {
        onSelectSession(nextSession.terminalSessionId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeProjectId,
    activeSessionId,
    enabled,
    onSelectProject,
    onSelectSession,
    visibleProjects,
    visibleSessions,
  ]);
}

interface SessionMarkerCleanupOptions {
  sessions: TerminalSessionListItem[];
  historyTerminalSessionId: string | null;
  setCompletionMarkers: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setBellMarkers: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setHistoryDrawerOpen: (open: boolean) => void;
  setHistoryTerminalSessionId: (terminalSessionId: string | null) => void;
}

export function useSessionMarkerCleanup({
  sessions,
  historyTerminalSessionId,
  setCompletionMarkers,
  setBellMarkers,
  setHistoryDrawerOpen,
  setHistoryTerminalSessionId,
}: SessionMarkerCleanupOptions): void {
  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.terminalSessionId));
    setCompletionMarkers((current) => {
      let changed = false;
      const nextEntries = Object.entries(current).filter(([terminalSessionId, active]) => {
        const keep = active && sessionIds.has(terminalSessionId);
        if (!keep) {
          changed = true;
        }
        return keep;
      });

      if (!changed) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });
  }, [sessions, setCompletionMarkers]);

  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.terminalSessionId));
    setBellMarkers((current) => {
      let changed = false;
      const nextEntries = Object.entries(current).filter(([terminalSessionId, active]) => {
        const keep = active && sessionIds.has(terminalSessionId);
        if (!keep) {
          changed = true;
        }
        return keep;
      });

      if (!changed) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });
  }, [sessions, setBellMarkers]);

  useEffect(() => {
    if (!historyTerminalSessionId) {
      return;
    }

    if (
      sessions.some(
        (session) => session.terminalSessionId === historyTerminalSessionId,
      )
    ) {
      return;
    }

    setHistoryDrawerOpen(false);
    setHistoryTerminalSessionId(null);
  }, [
    historyTerminalSessionId,
    sessions,
    setHistoryDrawerOpen,
    setHistoryTerminalSessionId,
  ]);
}

interface PersistRecentSelectionOptions {
  apiBase: string;
  activeProjectId: string | null;
  activeSessionId: string | null;
  hasLoadedSessions: boolean;
  requestError: string | null;
}

export function usePersistRecentSelection({
  apiBase,
  activeProjectId,
  activeSessionId,
  hasLoadedSessions,
  requestError,
}: PersistRecentSelectionOptions): void {
  useEffect(() => {
    if (!hasLoadedSessions || requestError || !activeProjectId) {
      return;
    }

    saveRecentTerminalSelection(apiBase, {
      projectId: activeProjectId,
      terminalSessionId: activeSessionId,
    });
  }, [activeProjectId, activeSessionId, apiBase, hasLoadedSessions, requestError]);
}
