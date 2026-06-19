import type {
  AppHomeOverviewSession,
  TerminalInputMode,
  TerminalState,
} from "@runweave/shared";
import { fileToBase64, shellQuote } from "@runweave/common/terminal";
import { type TerminalRendererHandle } from "@runweave/terminal-renderer";
import { IonContent, IonPage } from "@ionic/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AppTerminalDetailTab,
  TerminalDetailTabBar,
} from "../components/TerminalDetailTabBar";
import { AppTerminalDeleteAlerts } from "../components/AppTerminalDeleteAlerts";
import { AppTerminalHeader } from "../components/AppTerminalHeader";
import { AppTerminalPanels } from "../components/AppTerminalPanels";
import { type SelectedTerminalChange } from "../components/TerminalChangesTab";
import { TerminalCommandComposer } from "../components/TerminalCommandComposer";
import type { AppConnectionConfig } from "../features/connections/types";
import { recordSupportLog, useSupportLogs } from "../features/support-logs";
import { basename, shortPath } from "../lib/app-terminal-path-labels";
import { formatRelativeTime } from "../lib/terminal-home-view-model";
import { useAppTerminalConnection } from "../hooks/use-app-terminal-connection";
import type { AppDeviceConnectionSnapshot } from "../hooks/use-app-device-connection";
import { classifyApiFailure } from "../services/api-failure";
import {
  createTerminalSessionClipboardImage,
  getCurrentTerminalState,
  interruptTerminalSession,
  sendTerminalInput,
} from "../services/terminal";
import { transcribeVoice } from "../services/voice";

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

function resolveComposerInputMode(
  terminalState: TerminalState,
  data: string,
): TerminalInputMode {
  if (terminalState.agent === "codex" && data.trimStart().startsWith("/")) {
    return "codex_slash_command";
  }
  return "line";
}

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
  const [activeTab, setActiveTab] = useState<AppTerminalDetailTab>("chat");
  const [changesCount, setChangesCount] = useState(0);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeletingTerminal, setIsDeletingTerminal] = useState(false);
  const [requestedChange, setRequestedChange] =
    useState<SelectedTerminalChange | null>(null);
  const terminalStateRef = useRef<TerminalState>({
    state: "shell_idle",
    agent: null,
  });
  const [imageError, setImageError] = useState<string | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [terminalState, setTerminalState] = useState<TerminalState>(
    () => initialSession?.terminalState ?? SHELL_IDLE_STATE,
  );
  terminalStateRef.current = terminalState;
  const isDeviceOffline = deviceConnection.status === "offline";
  const refreshDeviceAfterFailure = useCallback(() => {
    void onRefreshDeviceConnection();
  }, [onRefreshDeviceConnection]);
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
  const statusLabel =
    isDeviceOffline
      ? "Computer Offline"
      : runtimeStatus === "exited"
        ? "Exited"
        : connectionStatus === "connected"
          ? "Connected"
          : "Connecting";
  const statusClass =
    isDeviceOffline
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
    setConfirmDeleteOpen(false);
    setDeleteError(null);
    setIsDeletingTerminal(false);
    setTerminalState(initialState);
  }, [initialSession?.terminalState, terminalSessionId]);

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
            recordSupportLog("terminal.state.poll.not_found", {
              terminalSessionId,
              previousState: terminalStateRef.current.state,
            }, "warn");
            setTerminalState({ state: "shell_idle", agent: null });
            return;
          }
          refreshDeviceAfterFailure();
          recordSupportLog("terminal.state.poll.failed", {
            terminalSessionId,
            error: nextError instanceof Error ? nextError.message : String(nextError),
          }, "warn");
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

  const isCommandActive = terminalState.state === "agent_running";

  const handleRequestDeleteTerminal = useCallback(() => {
    setDeleteError(null);
    if (isDeviceOffline) {
      setDeleteError("本地电脑暂时不可用");
      return;
    }
    setConfirmDeleteOpen(true);
  }, [isDeviceOffline]);

  const handleDeleteTerminal = useCallback(async (): Promise<void> => {
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
        recordSupportLog("terminal.delete.unauthorized", {
          terminalSessionId,
        }, "warn");
        onAuthExpired();
        return;
      }
      refreshDeviceAfterFailure();
      recordSupportLog("terminal.delete.failed", {
        terminalSessionId,
        error: nextError instanceof Error ? nextError.message : String(nextError),
      }, "warn");
      setIsDeletingTerminal(false);
      setDeleteError(
        nextError instanceof Error ? nextError.message : "删除终端失败",
      );
      setConfirmDeleteOpen(false);
    }
  }, [
    isDeletingTerminal,
    isDeviceOffline,
    onAuthExpired,
    onDeleteTerminal,
    refreshDeviceAfterFailure,
    terminalSessionId,
  ]);

  const moreMenuItems = useMemo(
    () => [
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

  const handleStop = useCallback(() => {
    setImageError(null);
    if (isDeviceOffline) {
      setImageError("本地电脑暂时不可用");
      return;
    }
    recordSupportLog("terminal.stop.clicked", {
      terminalSessionId,
      stateAtClick: terminalStateRef.current.state,
      agentAtClick: terminalStateRef.current.agent,
    });
    void interruptTerminalSession(apiBase, accessToken, terminalSessionId)
      .then(() => {
        recordSupportLog("terminal.stop.completed", {
          terminalSessionId,
          stateAfterSuccess: terminalStateRef.current.state,
          agentAfterSuccess: terminalStateRef.current.agent,
        });
      })
    .catch((nextError: unknown) => {
      const failure = classifyApiFailure(nextError);
      if (failure.kind === "auth-expired") {
        recordSupportLog("terminal.stop.unauthorized", {
          terminalSessionId,
        }, "warn");
        onAuthExpired();
        return;
      }
      refreshDeviceAfterFailure();
      recordSupportLog("terminal.stop.failed", {
        terminalSessionId,
        stateAfterFailure: terminalStateRef.current.state,
        error: nextError instanceof Error ? nextError.message : String(nextError),
      }, "warn");
      setImageError(
        nextError instanceof Error ? nextError.message : "中断命令失败",
      );
    });
  }, [
    accessToken,
    apiBase,
    isDeviceOffline,
    onAuthExpired,
    refreshDeviceAfterFailure,
    terminalSessionId,
  ]);
  const handleSendCommand = useCallback(
    async (data: string): Promise<void> => {
      if (isDeviceOffline) {
        setImageError("本地电脑暂时不可用");
        throw new Error("本地电脑暂时不可用");
      }
      const mode = resolveComposerInputMode(terminalStateRef.current, data);
      recordSupportLog("terminal.input.send.started", {
        terminalSessionId,
        hasNewline: data.includes("\n"),
        length: data.length,
        mode,
      });
      try {
        await sendTerminalInput(
          apiBase,
          accessToken,
          terminalSessionId,
          data,
          mode,
        );
        recordSupportLog("terminal.input.send.completed", {
          terminalSessionId,
          length: data.length,
          mode,
        });
      } catch (nextError: unknown) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          recordSupportLog("terminal.input.send.unauthorized", {
            terminalSessionId,
            length: data.length,
            mode,
          }, "warn");
          onAuthExpired();
          return;
        }
        refreshDeviceAfterFailure();
        recordSupportLog("terminal.input.send.failed", {
          terminalSessionId,
          error: nextError instanceof Error ? nextError.message : String(nextError),
          length: data.length,
          mode,
        }, "warn");
        setImageError(
          nextError instanceof Error ? nextError.message : "命令发送失败",
        );
        throw nextError;
      }
    },
    [
      accessToken,
      apiBase,
      isDeviceOffline,
      onAuthExpired,
      refreshDeviceAfterFailure,
      terminalSessionId,
    ],
  );
  const handlePickImage = useCallback(
    async (file: File): Promise<string> => {
      setImageError(null);
      if (isDeviceOffline) {
        setImageError("本地电脑暂时不可用");
        throw new Error("本地电脑暂时不可用");
      }
      setIsPickingImage(true);
      recordSupportLog("terminal.clipboard_image.upload.started", {
        terminalSessionId,
        mimeType: file.type,
        size: file.size,
      });
      try {
        const dataBase64 = await fileToBase64(file);
        const payload = await createTerminalSessionClipboardImage(
          apiBase,
          accessToken,
          terminalSessionId,
          {
            mimeType: file.type,
            dataBase64,
          },
        );
        recordSupportLog("terminal.clipboard_image.upload.completed", {
          terminalSessionId,
          filePathLength: payload.filePath.length,
        });
        return shellQuote(payload.filePath);
      } catch (nextError: unknown) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          recordSupportLog("terminal.clipboard_image.upload.unauthorized", {
            terminalSessionId,
          }, "warn");
          onAuthExpired();
          throw nextError;
        }
        refreshDeviceAfterFailure();
        recordSupportLog("terminal.clipboard_image.upload.failed", {
          terminalSessionId,
          error: nextError instanceof Error ? nextError.message : String(nextError),
        }, "warn");
        setImageError(
          nextError instanceof Error ? nextError.message : "图片上传失败",
        );
        throw nextError;
      } finally {
        setIsPickingImage(false);
      }
    },
    [
      accessToken,
      apiBase,
      isDeviceOffline,
      onAuthExpired,
      refreshDeviceAfterFailure,
      terminalSessionId,
    ],
  );

  const handleTranscribeVoice = useCallback(
    async (payload: Parameters<typeof transcribeVoice>[2]): Promise<string> => {
      setImageError(null);
      if (isDeviceOffline) {
        setImageError("本地电脑暂时不可用");
        throw new Error("本地电脑暂时不可用");
      }
      recordSupportLog("terminal.voice.transcribe.started", {
        terminalSessionId,
        durationMs: payload.durationMs,
      });
      try {
        const response = await transcribeVoice(apiBase, accessToken, payload);
        recordSupportLog("terminal.voice.transcribe.completed", {
          terminalSessionId,
          textLength: response.text.length,
        });
        return response.text;
      } catch (nextError: unknown) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          recordSupportLog(
            "terminal.voice.transcribe.unauthorized",
            {
              terminalSessionId,
            },
            "warn",
          );
          onAuthExpired();
          throw nextError;
        }
        refreshDeviceAfterFailure();
        recordSupportLog(
          "terminal.voice.transcribe.failed",
          {
            terminalSessionId,
            error:
              nextError instanceof Error
                ? nextError.message
                : String(nextError),
          },
          "warn",
        );
        setImageError(
          nextError instanceof Error ? nextError.message : "语音转文字失败",
        );
        throw nextError;
      }
    },
    [
      accessToken,
      apiBase,
      isDeviceOffline,
      onAuthExpired,
      refreshDeviceAfterFailure,
      terminalSessionId,
    ],
  );

  const handleShowChanges = useCallback(
    (change: SelectedTerminalChange) => {
      setRequestedChange(change);
      recordSupportLog("terminal.tab.changed", {
        terminalSessionId,
        previousTab: activeTab,
        nextTab: "changes",
      });
      setActiveTab("changes");
    },
    [activeTab, terminalSessionId],
  );

  const handleTabChange = useCallback(
    (nextTab: AppTerminalDetailTab) => {
      recordSupportLog("terminal.tab.changed", {
        terminalSessionId,
        previousTab: activeTab,
        nextTab,
      });
      setActiveTab(nextTab);
    },
    [activeTab, terminalSessionId],
  );

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
          <AppTerminalPanels
            accessToken={accessToken}
            activeProjectId={activeProjectId}
            activeTab={activeTab}
            apiBase={apiBase}
            connectionStatus={connectionStatus}
            error={error}
            hasMetadata={Boolean(metadata)}
            isDeviceOffline={isDeviceOffline}
            notFound={notFound}
            onRefreshDeviceConnection={onRefreshDeviceConnection}
            requestedChange={requestedChange}
            rendererRef={rendererRef}
            runtimeKind={runtimeKind}
            sendInput={sendInput}
            sendResize={sendResize}
            onAuthExpired={onAuthExpired}
            onBack={onBack}
            onChangesCount={setChangesCount}
            onTerminalReady={onRendererReady}
            onShowChanges={handleShowChanges}
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
