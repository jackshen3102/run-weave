import { useMemoizedFn } from "ahooks";
import type { AppHomeOverviewSession, TerminalState } from "@runweave/shared";
import { type TerminalRendererHandle } from "@runweave/terminal-renderer";
import { IonContent, IonPage } from "@ionic/react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type AppTerminalDetailTab,
  TerminalDetailTabBar,
} from "../components/TerminalDetailTabBar";
import { AppTerminalDeleteAlerts } from "../components/AppTerminalDeleteAlerts";
import { AppTerminalHeader } from "../components/AppTerminalHeader";
import { AppTerminalPanels } from "../components/AppTerminalPanels";
import { TerminalHistoryModal } from "../components/TerminalHistoryModal";
import { TerminalCommandComposer } from "../components/TerminalCommandComposer";
import type { AppConnectionConfig } from "../features/connections/types";
import { recordSupportLog, useSupportLogs } from "../features/support-logs";
import { basename, shortPath } from "../lib/app-terminal-path-labels";
import { formatRelativeTime } from "../lib/terminal-home-view-model";
import { useAppTerminalActions } from "../hooks/use-app-terminal-actions";
import { useAppTerminalConnection } from "../hooks/use-app-terminal-connection";
import type { AppDeviceConnectionSnapshot } from "../hooks/use-app-device-connection";
import { classifyApiFailure } from "../services/api-failure";
import { getCurrentTerminalState } from "../services/terminal";
import { useAppTerminalUiStore } from "../store/use-app-terminal-ui-store";

interface AppTerminalPageProps {
  accessToken: string;
  activeConnection: AppConnectionConfig | null;
  apiBase: string;
  deviceConnection: AppDeviceConnectionSnapshot;
  initialSession?: AppHomeOverviewSession;
  terminalSessionId: string;
  onAuthExpired: () => void;
  onBack: () => void;
  onDeleteTerminal: () => Promise<void>;
  onRefreshDeviceConnection: () => Promise<AppDeviceConnectionSnapshot>;
}

const SHELL_IDLE_STATE: TerminalState = {
  state: "shell_idle",
  agent: null,
};

export function AppTerminalPage({
  accessToken,
  activeConnection,
  apiBase,
  deviceConnection,
  initialSession,
  terminalSessionId,
  onAuthExpired,
  onBack,
  onDeleteTerminal,
  onRefreshDeviceConnection,
}: AppTerminalPageProps) {
  const { openSupportLogs } = useSupportLogs();
  const rendererRef = useRef<TerminalRendererHandle | null>(null);
  const activeTab = useAppTerminalUiStore((state) => state.activeTab);
  const changesCount = useAppTerminalUiStore((state) => state.changesCount);
  const confirmDeleteOpen = useAppTerminalUiStore(
    (state) => state.confirmDeleteOpen,
  );
  const deleteError = useAppTerminalUiStore((state) => state.deleteError);
  const isDeletingTerminal = useAppTerminalUiStore(
    (state) => state.isDeletingTerminal,
  );
  const setActiveTab = useAppTerminalUiStore((state) => state.setActiveTab);
  const setConfirmDeleteOpen = useAppTerminalUiStore(
    (state) => state.setConfirmDeleteOpen,
  );
  const setDeleteError = useAppTerminalUiStore((state) => state.setDeleteError);
  const setIsDeletingTerminal = useAppTerminalUiStore(
    (state) => state.setIsDeletingTerminal,
  );
  const resetTerminalUi = useAppTerminalUiStore(
    (state) => state.resetForTerminal,
  );
  const terminalStateRef = useRef<TerminalState>({
    state: "shell_idle",
    agent: null,
  });
  const [terminalState, setTerminalState] = useState<TerminalState>(
    () => initialSession?.terminalState ?? SHELL_IDLE_STATE,
  );
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  terminalStateRef.current = terminalState;
  const isDeviceOffline = deviceConnection.status === "offline";
  const refreshDeviceAfterFailure = useMemoizedFn(() => {
    void onRefreshDeviceConnection();
  });
  const {
    connectionStatus,
    error,
    metadata,
    notFound,
    onRendererReady,
    runtimeStatus,
    runtimeKind,
    sendInput,
    sendResize,
  } = useAppTerminalConnection({
    apiBase,
    accessToken,
    terminalSessionId,
    rendererRef,
    enabled: !isDeviceOffline,
    canQueueInput: !isDeviceOffline,
    onAuthExpired,
    onConnectionFailure: refreshDeviceAfterFailure,
  });

  const title = useMemo(() => {
    if (metadata?.activeCommand) {
      return metadata.activeCommand;
    }
    if (metadata?.command) {
      return basename(metadata.command);
    }
    return initialSession?.title ?? "Terminal";
  }, [initialSession?.title, metadata?.activeCommand, metadata?.command]);
  const subtitle = metadata?.cwd
    ? shortPath(metadata.cwd)
    : (initialSession?.subtitle ?? "");
  const activeProjectId =
    metadata?.projectId ?? initialSession?.projectId ?? null;
  const lastActivityAt =
    metadata?.lastActivityAt ?? initialSession?.lastActivityAt;
  const statusLabel = isDeviceOffline
    ? "Computer Offline"
    : runtimeStatus === "exited"
      ? "Exited"
      : connectionStatus === "connected"
        ? "Connected"
        : "Connecting";
  const statusClass = isDeviceOffline
    ? "offline"
    : connectionStatus === "connected"
      ? "connected"
      : connectionStatus === "closed"
        ? "closed"
        : "connecting";
  const supportLogScope = useMemo(
    () => ({
      source: "terminal" as const,
      route: `/terminal/${terminalSessionId}`,
      terminalSessionId,
      projectId: activeProjectId,
      connectionId: activeConnection?.id ?? null,
      connectionName: activeConnection?.name ?? null,
      connectionStatus,
      deviceStatus: deviceConnection.status,
      runtimeStatus,
      activeTab,
    }),
    [
      activeProjectId,
      activeTab,
      activeConnection?.id,
      activeConnection?.name,
      connectionStatus,
      deviceConnection.status,
      runtimeStatus,
      terminalSessionId,
    ],
  );
  useEffect(() => {
    const initialState = initialSession?.terminalState ?? SHELL_IDLE_STATE;
    resetTerminalUi();
    setTerminalState(initialState);
  }, [initialSession?.terminalState, resetTerminalUi, terminalSessionId]);

  useEffect(() => {
    if (notFound || isDeviceOffline) {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    recordSupportLog("terminal.page.mounted", {
      terminalSessionId,
      initialState: terminalStateRef.current.state,
      initialAgent: terminalStateRef.current.agent,
    });

    const refreshTerminalState = () => {
      recordSupportLog("terminal.state.poll.started", {
        terminalSessionId,
      });
      void getCurrentTerminalState(apiBase, accessToken, terminalSessionId)
        .then((payload) => {
          if (!cancelled) {
            recordSupportLog("terminal.state.poll.completed", {
              terminalSessionId,
              previousState: terminalStateRef.current.state,
              previousAgent: terminalStateRef.current.agent,
              nextState: payload.terminalState.state,
              nextAgent: payload.terminalState.agent,
            });
            setTerminalState(payload.terminalState);
          }
        })
        .catch((nextError: unknown) => {
          if (cancelled) {
            return;
          }
          const failure = classifyApiFailure(nextError);
          if (failure.kind === "auth-expired") {
            onAuthExpired();
            return;
          }
          if (failure.kind === "not-found") {
            recordSupportLog(
              "terminal.state.poll.not_found",
              {
                terminalSessionId,
                previousState: terminalStateRef.current.state,
              },
              "warn",
            );
            setTerminalState({ state: "shell_idle", agent: null });
            return;
          }
          refreshDeviceAfterFailure();
          recordSupportLog(
            "terminal.state.poll.failed",
            {
              terminalSessionId,
              error:
                nextError instanceof Error
                  ? nextError.message
                  : String(nextError),
            },
            "warn",
          );
        });
    };

    refreshTerminalState();
    timer = window.setInterval(refreshTerminalState, 2000);

    return () => {
      cancelled = true;
      recordSupportLog("terminal.page.unmounted", {
        terminalSessionId,
        lastState: terminalStateRef.current.state,
        lastAgent: terminalStateRef.current.agent,
      });
      if (timer !== null) {
        window.clearInterval(timer);
      }
    };
  }, [
    accessToken,
    apiBase,
    isDeviceOffline,
    notFound,
    onAuthExpired,
    refreshDeviceAfterFailure,
    terminalSessionId,
  ]);

  const {
    handlePickImage,
    handleSendCommand,
    handleStop,
    handleTranscribeVoice,
    imageError,
    isCommandActive,
    isPickingImage,
  } = useAppTerminalActions({
    accessToken,
    apiBase,
    isDeviceOffline,
    onAuthExpired,
    refreshDeviceAfterFailure,
    terminalSessionId,
    terminalState,
    terminalStateRef,
  });

  const handleSendShortcutInput = useMemoizedFn((data: string) => {
    void sendInput(data);
  });

  const handleRequestDeleteTerminal = useMemoizedFn(() => {
    setDeleteError(null);
    if (isDeviceOffline) {
      setDeleteError("本地电脑暂时不可用");
      return;
    }
    setConfirmDeleteOpen(true);
  });

  const handleOpenHistory = useMemoizedFn(() => {
    setHistoryModalOpen(true);
  });

  const handleDeleteTerminal = useMemoizedFn(async (): Promise<void> => {
    if (isDeletingTerminal) {
      return;
    }
    if (isDeviceOffline) {
      setDeleteError("本地电脑暂时不可用");
      setConfirmDeleteOpen(false);
      return;
    }
    setIsDeletingTerminal(true);
    setDeleteError(null);
    recordSupportLog("terminal.delete.started", {
      terminalSessionId,
      stateAtClick: terminalStateRef.current.state,
      agentAtClick: terminalStateRef.current.agent,
    });
    try {
      await onDeleteTerminal();
      recordSupportLog("terminal.delete.completed", {
        terminalSessionId,
      });
    } catch (nextError: unknown) {
      const failure = classifyApiFailure(nextError);
      if (failure.kind === "auth-expired") {
        recordSupportLog(
          "terminal.delete.unauthorized",
          {
            terminalSessionId,
          },
          "warn",
        );
        onAuthExpired();
        return;
      }
      refreshDeviceAfterFailure();
      recordSupportLog(
        "terminal.delete.failed",
        {
          terminalSessionId,
          error:
            nextError instanceof Error ? nextError.message : String(nextError),
        },
        "warn",
      );
      setIsDeletingTerminal(false);
      setDeleteError(
        nextError instanceof Error ? nextError.message : "删除终端失败",
      );
      setConfirmDeleteOpen(false);
    }
  });

  const moreMenuItems = useMemo(
    () => [
      {
        label: "终端历史",
        onClick: handleOpenHistory,
      },
      {
        label: "日志上报",
        onClick: () => openSupportLogs(supportLogScope),
      },
      {
        label: isDeletingTerminal ? "删除中..." : "删除终端",
        onClick: handleRequestDeleteTerminal,
        tone: "danger" as const,
      },
    ],
    [
      handleOpenHistory,
      handleRequestDeleteTerminal,
      isDeletingTerminal,
      openSupportLogs,
      supportLogScope,
    ],
  );

  useEffect(() => {
    if (activeTab === "chat") {
      rendererRef.current?.refresh();
    }
  }, [activeTab]);

  const handleTabChange = useMemoizedFn((nextTab: AppTerminalDetailTab) => {
    recordSupportLog("terminal.tab.changed", {
      terminalSessionId,
      previousTab: activeTab,
      nextTab,
    });
    setActiveTab(nextTab);
  });

  return (
    <IonPage>
      <IonContent
        fullscreen
        scrollY={false}
        className="terminal-page bg-background text-foreground"
      >
        <main className="terminal-page-shell min-h-dvh bg-background">
          <AppTerminalHeader
            connectionStatus={statusClass}
            formatRelativeTime={formatRelativeTime}
            lastActivityAt={lastActivityAt}
            moreMenuItems={moreMenuItems}
            onBack={onBack}
            onRefresh={() => {
              if (isDeviceOffline) {
                void onRefreshDeviceConnection();
                return;
              }
              rendererRef.current?.refresh();
            }}
            statusLabel={statusLabel}
            subtitle={subtitle}
            terminalSessionId={terminalSessionId}
            title={title}
          />
          <AppTerminalDeleteAlerts
            confirmDeleteOpen={confirmDeleteOpen}
            deleteError={deleteError}
            isDeletingTerminal={isDeletingTerminal}
            onConfirmDelete={() => void handleDeleteTerminal()}
            onDismissConfirm={() => {
              if (!isDeletingTerminal) {
                setConfirmDeleteOpen(false);
              }
            }}
            onDismissError={() => setDeleteError(null)}
          />
          <TerminalHistoryModal
            accessToken={accessToken}
            apiBase={apiBase}
            isDeviceOffline={isDeviceOffline}
            isOpen={historyModalOpen}
            onAuthExpired={onAuthExpired}
            onClose={() => setHistoryModalOpen(false)}
            onConnectionFailure={refreshDeviceAfterFailure}
            terminalName={title}
            terminalSessionId={terminalSessionId}
          />
          <AppTerminalPanels
            accessToken={accessToken}
            activeProjectId={activeProjectId}
            apiBase={apiBase}
            connectionStatus={connectionStatus}
            error={error}
            hasMetadata={Boolean(metadata)}
            isDeviceOffline={isDeviceOffline}
            notFound={notFound}
            onRefreshDeviceConnection={onRefreshDeviceConnection}
            rendererRef={rendererRef}
            runtimeKind={runtimeKind}
            sendInput={sendInput}
            sendResize={sendResize}
            terminalSessionId={terminalSessionId}
            onAuthExpired={onAuthExpired}
            onBack={onBack}
            onTerminalReady={onRendererReady}
          />
          {activeTab === "chat" ? (
            <div className="terminal-composer-slot">
              {imageError ? (
                <p className="terminal-composer-error">{imageError}</p>
              ) : null}
              <TerminalCommandComposer
                disabled={notFound || isDeviceOffline}
                isPickingImage={isPickingImage}
                isStopping={isCommandActive}
                onPickImage={handlePickImage}
                onSendInput={handleSendCommand}
                onSendShortcutInput={handleSendShortcutInput}
                onStop={handleStop}
                onTranscribeVoice={handleTranscribeVoice}
              />
            </div>
          ) : null}
          <TerminalDetailTabBar
            activeTab={activeTab}
            changesCount={changesCount}
            onTabChange={handleTabChange}
          />
        </main>
      </IonContent>
    </IonPage>
  );
}
