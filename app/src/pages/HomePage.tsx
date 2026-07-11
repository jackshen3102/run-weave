import type { CreateTerminalProjectRequest, TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { AppHomeOverviewResponse } from "@runweave/shared/terminal/session";
import {
  IonButton,
  IonContent,
  IonInput,
  IonModal,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSearchbar,
  IonSpinner,
  IonText,
  type RefresherCustomEvent,
} from "@ionic/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { AppConnectionChip } from "../components/AppConnectionChip";
import { AppConnectionManager } from "../components/AppConnectionManager";
import { AppMoreMenu } from "../components/AppMoreMenu";
import type { AppConnectionConfig } from "../features/connections/types";
import { useSupportLogs } from "../features/support-logs";
import type { AppDeviceConnectionSnapshot } from "../hooks/use-app-device-connection";
import {
  buildTerminalHomeGroups,
  type TerminalHomeProjectGroup,
} from "../lib/terminal-home-view-model";
import { ProjectGroup } from "../components/ProjectGroup";

interface HomePageProps {
  activeConnection: AppConnectionConfig | null;
  overview: AppHomeOverviewResponse | null;
  loading: boolean;
  error: string | null;
  deviceConnection: AppDeviceConnectionSnapshot;
  onRefresh: () => Promise<void>;
  onLogout: () => void;
  onOpenTerminal: (terminalSessionId: string) => void;
  onCreateProject: (
    payload: CreateTerminalProjectRequest,
  ) => Promise<TerminalProjectListItem>;
  onCreateTerminal: (projectId: string) => Promise<void>;
}

function buildInitialExpanded(groups: TerminalHomeProjectGroup[]): Set<string> {
  return new Set(groups.slice(0, 4).map((group) => group.project.projectId));
}

export function HomePage({
  activeConnection,
  overview,
  loading,
  error,
  deviceConnection,
  onRefresh,
  onLogout,
  onOpenTerminal,
  onCreateProject,
  onCreateTerminal,
}: HomePageProps) {
  const { openSupportLogs } = useSupportLogs();
  const [query, setQuery] = useState("");
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(
    null,
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectCreateError, setProjectCreateError] = useState<string | null>(
    null,
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [connectionManagerOpen, setConnectionManagerOpen] = useState(false);
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
        label: "新增项目",
        onClick: () => {
          setProjectName("");
          setProjectPath("");
          setProjectCreateError(null);
          setProjectModalOpen(true);
        },
      },
      {
        label: "连接管理",
        onClick: () => setConnectionManagerOpen(true),
      },
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
    if (deviceConnection.status === "offline") {
      setCreateError("本地电脑暂时不可用");
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

  const handleCreateProject = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingProject) {
      return;
    }

    const nextName = projectName.trim();
    const nextPath = projectPath.trim();
    if (!nextName) {
      setProjectCreateError("请输入项目名称");
      return;
    }

    setCreatingProject(true);
    setProjectCreateError(null);
    try {
      const created = await onCreateProject({
        name: nextName,
        path: nextPath || null,
      });
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        next.add(created.projectId);
        return next;
      });
      setQuery("");
      setProjectModalOpen(false);
      setProjectName("");
      setProjectPath("");
    } catch (nextError) {
      setProjectCreateError(
        nextError instanceof Error ? nextError.message : "创建项目失败",
      );
    } finally {
      setCreatingProject(false);
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
            <div className="home-header__identity">
              <div className="home-header__title-row">
                <p className="text-muted-foreground">Runweave</p>
                <AppConnectionChip
                  connection={activeConnection}
                  onClick={() => setConnectionManagerOpen(true)}
                  status={deviceConnection.status}
                />
              </div>
            </div>
            <nav aria-label="Home actions">
              <AppMoreMenu items={moreMenuItems} />
            </nav>
          </header>
          {deviceConnection.status === "offline" ? (
            <p className="home-offline-banner">
              本地电脑暂时不可用，列表会保留最近一次加载的数据。
            </p>
          ) : null}
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
          {error && deviceConnection.status !== "offline" ? (
            <IonText color="danger">
              <p className="home-error">{error}</p>
            </IonText>
          ) : null}
          {createError && deviceConnection.status !== "offline" ? (
            <IonText color="danger">
              <p className="home-error">{createError}</p>
            </IonText>
          ) : null}
          {!loading && overview && overview.projects.length === 0 ? (
            <p className="home-empty text-muted-foreground">暂无项目</p>
          ) : null}
          {!loading && !overview && deviceConnection.status === "offline" ? (
            <p className="home-empty text-muted-foreground">
              本地电脑离线。下拉刷新可重新检测。
            </p>
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
                createDisabled={deviceConnection.status === "offline"}
                onOpenTerminal={onOpenTerminal}
                onToggle={() => toggleProject(group.project.projectId)}
              />
            ))}
          </div>
        </main>
      </IonContent>
      <IonModal
        canDismiss={!creatingProject}
        className="home-project-modal"
        isOpen={projectModalOpen}
        onDidDismiss={() => {
          if (!creatingProject) {
            setProjectModalOpen(false);
          }
        }}
      >
        <form className="home-project-form" onSubmit={handleCreateProject}>
          <header className="home-project-form__header">
            <h2>新增项目</h2>
            <button
              aria-label="Close new project"
              disabled={creatingProject}
              onClick={() => setProjectModalOpen(false)}
              type="button"
            >
              关闭
            </button>
          </header>
          <div className="home-project-form__body">
            <IonInput
              className="app-input"
              disabled={creatingProject}
              label="项目名称"
              labelPlacement="stacked"
              onIonInput={(event) =>
                setProjectName(String(event.detail.value ?? ""))
              }
              value={projectName}
            />
            <IonInput
              className="app-input"
              disabled={creatingProject}
              label="项目路径"
              labelPlacement="stacked"
              onIonInput={(event) =>
                setProjectPath(String(event.detail.value ?? ""))
              }
              placeholder="/Users/me/project"
              value={projectPath}
            />
            {projectCreateError ? (
              <IonText color="danger">
                <p className="home-project-form__error">{projectCreateError}</p>
              </IonText>
            ) : null}
            <IonButton
              className="home-project-form__submit"
              disabled={creatingProject}
              expand="block"
              type="submit"
            >
              {creatingProject ? "创建中..." : "创建项目"}
            </IonButton>
          </div>
        </form>
      </IonModal>
      <AppConnectionManager
        isOpen={connectionManagerOpen}
        onDidDismiss={() => setConnectionManagerOpen(false)}
      />
    </IonPage>
  );
}
