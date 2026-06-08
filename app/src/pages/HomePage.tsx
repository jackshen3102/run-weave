import type { TerminalMobileOverviewResponse } from "@browser-viewer/shared";
import {
  IonButton,
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

import {
  buildTerminalHomeGroups,
  type TerminalHomeProjectGroup,
} from "../lib/terminal-home-view-model";
import { ProjectGroup } from "../components/ProjectGroup";

interface HomePageProps {
  apiBase: string;
  overview: TerminalMobileOverviewResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onLogout: () => void;
  onOpenTerminal: (terminalSessionId: string) => void;
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
}: HomePageProps) {
  const [query, setQuery] = useState("");
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
              <IonButton fill="clear" onClick={() => void onRefresh()}>
                Refresh
              </IonButton>
              <IonButton fill="clear" onClick={onLogout}>
                Logout
              </IonButton>
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
          {!loading && overview && overview.projects.length === 0 ? (
            <p className="home-empty text-muted-foreground">暂无项目</p>
          ) : null}
          <div className="project-list grid">
            {groups.map((group) => (
              <ProjectGroup
                expanded={expandedProjectIds.has(group.project.projectId)}
                group={group}
                key={group.project.projectId}
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
