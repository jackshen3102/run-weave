import type { AppHomeOverviewResponse } from "@browser-viewer/shared";
import {
  IonContent,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSearchbar,
  IonSpinner,
  IonText,
  type RefresherCustomEvent,
} from "@ionic/react";
import { useEffect, useMemo, useState } from "react";

import { AppMoreMenu } from "../components/AppMoreMenu";
import { useSupportLogs } from "../features/support-logs";
import {
  buildTerminalHomeGroups,
  type TerminalHomeProjectGroup,
} from "../lib/terminal-home-view-model";
import { ProjectGroup } from "../components/ProjectGroup";

interface HomePageProps {
  apiBase: string;
  overview: AppHomeOverviewResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onLogout: () => void;
  onOpenTerminal: (terminalSessionId: string) => void;
  onCreateTerminal: (projectId: string) => Promise<void>;
}

function buildInitialExpanded(groups: TerminalHomeProjectGroup[]): Set<string> {
  return new Set(groups.slice(0, 4).map((group) => group.project.projectId));
}

function formatApiBaseLabel(apiBase: string): string {
  if (apiBase) {
    return apiBase.replace(/^https?:\/\//, "");
  }
  if (typeof window !== "undefined") {
    return window.location.host;
  }
  return "local";
}

export function HomePage({
  apiBase,
  overview,
  loading,
  error,
  onRefresh,
  onLogout,
  onOpenTerminal,
  onCreateTerminal,
}: HomePageProps) {
  const { openSupportLogs } = useSupportLogs();
  const [query, setQuery] = useState("");
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(
    null,
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const groups = useMemo(
    () =>
      buildTerminalHomeGroups(
        overview ?? { projects: [], sessions: [] },
        query,
      ),
    [overview, query],
  );
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => buildInitialExpanded(groups),
  );
  const moreMenuItems = useMemo(
    () => [
      {
        label: "日志上报",
        onClick: () => openSupportLogs({ source: "home", route: "/home" }),
      },
      {
        label: "Logout",
        onClick: onLogout,
        tone: "danger" as const,
      },
    ],
    [onLogout, openSupportLogs],
  );

  useEffect(() => {
    setExpandedProjectIds((current) => {
      if (current.size > 0 || groups.length === 0) {
        return current;
      }
      return buildInitialExpanded(groups);
    });
  }, [groups]);

  const handleRefresh = async (event: RefresherCustomEvent) => {
    try {
      await onRefresh();
    } finally {
      event.detail.complete();
    }
  };

  const toggleProject = (projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const handleCreateTerminal = async (projectId: string) => {
    if (creatingProjectId) {
      return;
    }

    setCreatingProjectId(projectId);
    setCreateError(null);
    try {
      await onCreateTerminal(projectId);
    } catch (nextError) {
      setCreateError(
        nextError instanceof Error ? nextError.message : "创建终端失败",
      );
    } finally {
      setCreatingProjectId(null);
    }
  };

  return (
    <IonPage>
      <IonContent fullscreen className="home-page bg-background text-foreground">
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>
        <main className="home-shell min-h-full">
          <header className="home-header">
            <div>
              <p className="text-muted-foreground">Runweave</p>
              <span className="text-muted-foreground">
                {formatApiBaseLabel(apiBase)}
              </span>
            </div>
            <nav aria-label="Home actions">
              <AppMoreMenu items={moreMenuItems} />
            </nav>
          </header>
          <IonSearchbar
            className="home-search"
            debounce={120}
            onIonInput={(event) => setQuery(String(event.detail.value ?? ""))}
            placeholder="Search projects and terminals"
            value={query}
          />
          {loading && !overview ? (
            <div className="home-state">
              <IonSpinner name="crescent" />
            </div>
          ) : null}
          {error ? (
            <IonText color="danger">
              <p className="home-error">{error}</p>
            </IonText>
          ) : null}
          {createError ? (
            <IonText color="danger">
              <p className="home-error">{createError}</p>
            </IonText>
          ) : null}
          {!loading && overview && overview.projects.length === 0 ? (
            <p className="home-empty text-muted-foreground">暂无项目</p>
          ) : null}
          <div className="project-list grid">
            {groups.map((group) => (
              <ProjectGroup
                expanded={expandedProjectIds.has(group.project.projectId)}
                group={group}
                key={group.project.projectId}
                creatingTerminal={creatingProjectId === group.project.projectId}
                onCreateTerminal={(projectId) => {
                  void handleCreateTerminal(projectId);
                }}
                onOpenTerminal={onOpenTerminal}
                onToggle={() => toggleProject(group.project.projectId)}
              />
            ))}
          </div>
        </main>
      </IonContent>
    </IonPage>
  );
}
