import type {
  AppHomeOverviewSession,
  TerminalInputMode,
  TerminalState,
} from "@browser-viewer/shared";
import {
  TerminalRenderer,
  type TerminalRendererHandle,
  type TerminalRendererExtensionContext,
} from "@browser-viewer/terminal-renderer";
import {
  IonButton,
  IonContent,
  IonPage,
  IonSpinner,
  IonText,
} from "@ionic/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AppTerminalDetailTab,
  TerminalDetailTabBar,
} from "../components/TerminalDetailTabBar";
import {
  type SelectedTerminalChange,
  TerminalChangesTab,
} from "../components/TerminalChangesTab";
import { TerminalCommandComposer } from "../components/TerminalCommandComposer";
import { TerminalFilesTab } from "../components/TerminalFilesTab";
import { aiDiagnosticLog } from "../lib/app-diagnostics";
import { fileToBase64, shellQuote } from "../lib/terminal-input-assets";
import { formatRelativeTime } from "../lib/terminal-home-view-model";
import { useAppTerminalConnection } from "../hooks/use-app-terminal-connection";
import { ApiError } from "../services/http";
import {
  createTerminalSessionClipboardImage,
  getCurrentTerminalState,
  interruptTerminalSession,
  sendTerminalInput,
} from "../services/terminal";

interface AppTerminalPageProps {
  accessToken: string;
  apiBase: string;
  initialSession?: AppHomeOverviewSession;
  terminalSessionId: string;
  onAuthExpired: () => void;
  onBack: () => void;
}

function basename(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function shortPath(value: string): string {
  if (!value) {
    return "";
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return value;
  }
  return `.../${parts.slice(-2).join("/")}`;
}

const APP_TERMINAL_TOUCH_SCROLL_MULTIPLIER = 3;
const APP_TERMINAL_EDGE_SWIPE_ZONE = 24;
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

function installTerminalTouchBehavior({
  terminal,
  container,
}: TerminalRendererExtensionContext): { dispose(): void } {
  let lastTouchY: number | null = null;
  let accumulatedDelta = 0;
  let edgeSwipeActive = false;
  let activePointerId: number | null = null;

  const resolveLineHeight = () => {
    const firstRow = container.querySelector<HTMLElement>(
      ".xterm-rows > div",
    );
    const measuredLineHeight = firstRow?.getBoundingClientRect().height ?? 0;
    if (measuredLineHeight > 0) {
      return measuredLineHeight;
    }
    return container.clientHeight / Math.max(terminal.rows, 1);
  };

  const suppressTerminalFocus = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    terminal.blur();
  };

  const suppressPointerFocus = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      return;
    }
    suppressTerminalFocus(event);
  };

  const resetScrollGesture = () => {
    lastTouchY = null;
    accumulatedDelta = 0;
    edgeSwipeActive = false;
    activePointerId = null;
  };

  const applyScrollDelta = (currentY: number, event: Event) => {
    if (lastTouchY === null) {
      lastTouchY = currentY;
      return;
    }

    accumulatedDelta +=
      (currentY - lastTouchY) * APP_TERMINAL_TOUCH_SCROLL_MULTIPLIER;
    lastTouchY = currentY;

    const lineHeight = resolveLineHeight();
    if (lineHeight <= 0) {
      return;
    }

    const lines = Math.trunc(accumulatedDelta / lineHeight);
    if (lines === 0) {
      return;
    }

    event.preventDefault();
    terminal.scrollLines(-lines);
    accumulatedDelta -= lines * lineHeight;
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      suppressPointerFocus(event);
      return;
    }

    edgeSwipeActive = event.clientX <= APP_TERMINAL_EDGE_SWIPE_ZONE;
    if (edgeSwipeActive) {
      activePointerId = null;
      lastTouchY = null;
      accumulatedDelta = 0;
      return;
    }

    event.stopPropagation();
    activePointerId = event.pointerId;
    lastTouchY = event.clientY;
    accumulatedDelta = 0;
    container.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (
      event.pointerType !== "touch" ||
      edgeSwipeActive ||
      activePointerId !== event.pointerId
    ) {
      return;
    }

    event.stopPropagation();
    applyScrollDelta(event.clientY, event);
  };

  const handlePointerEnd = (event: PointerEvent) => {
    if (activePointerId === event.pointerId) {
      container.releasePointerCapture?.(event.pointerId);
    }
    resetScrollGesture();
  };

  const handleTouchStart = (event: TouchEvent) => {
    const startX = event.touches[0]?.clientX ?? null;
    edgeSwipeActive =
      event.touches.length === 1 &&
      startX !== null &&
      startX <= APP_TERMINAL_EDGE_SWIPE_ZONE;
    if (edgeSwipeActive) {
      lastTouchY = null;
      accumulatedDelta = 0;
      return;
    }
    event.stopPropagation();
    if (event.touches.length !== 1) {
      lastTouchY = null;
      accumulatedDelta = 0;
      return;
    }
    lastTouchY = event.touches[0]?.clientY ?? null;
    accumulatedDelta = 0;
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (edgeSwipeActive) {
      return;
    }
    event.stopPropagation();
    const currentY = event.touches[0]?.clientY;
    if (lastTouchY === null || currentY === undefined) {
      return;
    }

    applyScrollDelta(currentY, event);
  };

  const handleTouchEnd = () => {
    resetScrollGesture();
  };

  const usePointerTouch = typeof window.PointerEvent !== "undefined";
  container.addEventListener("pointerdown", handlePointerDown, { capture: true });
  if (usePointerTouch) {
    container.addEventListener("pointermove", handlePointerMove, {
      capture: true,
    });
    container.addEventListener("pointerup", handlePointerEnd, {
      capture: true,
    });
    container.addEventListener("pointercancel", handlePointerEnd, {
      capture: true,
    });
  }
  container.addEventListener("mousedown", suppressTerminalFocus, {
    capture: true,
  });
  container.addEventListener("click", suppressTerminalFocus, {
    capture: true,
  });
  if (!usePointerTouch) {
    container.addEventListener("touchstart", handleTouchStart, {
      capture: true,
      passive: true,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      capture: true,
      passive: false,
    });
    container.addEventListener("touchend", handleTouchEnd, { capture: true });
    container.addEventListener("touchcancel", handleTouchEnd, { capture: true });
  }

  return {
    dispose() {
      container.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      if (usePointerTouch) {
        container.removeEventListener("pointermove", handlePointerMove, {
          capture: true,
        });
        container.removeEventListener("pointerup", handlePointerEnd, {
          capture: true,
        });
        container.removeEventListener("pointercancel", handlePointerEnd, {
          capture: true,
        });
      }
      container.removeEventListener("mousedown", suppressTerminalFocus, {
        capture: true,
      });
      container.removeEventListener("click", suppressTerminalFocus, {
        capture: true,
      });
      if (!usePointerTouch) {
        container.removeEventListener("touchstart", handleTouchStart, {
          capture: true,
        });
        container.removeEventListener("touchmove", handleTouchMove, {
          capture: true,
        });
        container.removeEventListener("touchend", handleTouchEnd, {
          capture: true,
        });
        container.removeEventListener("touchcancel", handleTouchEnd, {
          capture: true,
        });
      }
    },
  };
}

export function AppTerminalPage({
  accessToken,
  apiBase,
  initialSession,
  terminalSessionId,
  onAuthExpired,
  onBack,
}: AppTerminalPageProps) {
  const rendererRef = useRef<TerminalRendererHandle | null>(null);
  const [activeTab, setActiveTab] = useState<AppTerminalDetailTab>("chat");
  const [changesCount, setChangesCount] = useState(0);
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
  const {
    connectionStatus,
    error,
    metadata,
    notFound,
    runtimeStatus,
    sendInput,
    sendResize,
  } = useAppTerminalConnection({
    apiBase,
    accessToken,
    terminalSessionId,
    rendererRef,
    onAuthExpired,
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
  const activeProjectId = metadata?.projectId ?? initialSession?.projectId ?? null;
  const lastActivityAt =
    metadata?.lastActivityAt ?? initialSession?.lastActivityAt;
  const statusLabel =
    connectionStatus === "connected"
      ? runtimeStatus === "exited"
        ? "Exited"
        : "Connected"
      : "Connecting";
  useEffect(() => {
    const initialState = initialSession?.terminalState ?? SHELL_IDLE_STATE;
    setTerminalState(initialState);
  }, [initialSession?.terminalState, terminalSessionId]);

  useEffect(() => {
    if (notFound) {
      return;
    }
    let cancelled = false;

    aiDiagnosticLog("app terminal page mounted", {
      terminalSessionId,
      initialState: terminalStateRef.current.state,
      initialAgent: terminalStateRef.current.agent,
    });

    if (!initialSession?.terminalState) {
      aiDiagnosticLog("app terminal initial state request started", {
        terminalSessionId,
      });
      void getCurrentTerminalState(apiBase, accessToken, terminalSessionId)
        .then((payload) => {
          if (!cancelled) {
            aiDiagnosticLog("app terminal initial state request completed", {
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
          if (nextError instanceof ApiError && nextError.status === 401) {
            onAuthExpired();
            return;
          }
          if (nextError instanceof ApiError && nextError.status === 404) {
            aiDiagnosticLog("app terminal initial state request not found", {
              terminalSessionId,
              previousState: terminalStateRef.current.state,
            });
            setTerminalState({ state: "shell_idle", agent: null });
            return;
          }
          aiDiagnosticLog("app terminal initial state request failed", {
            terminalSessionId,
            error: nextError instanceof Error ? nextError.message : String(nextError),
          });
        });
    }

    return () => {
      cancelled = true;
      aiDiagnosticLog("app terminal page unmounted", {
        terminalSessionId,
        lastState: terminalStateRef.current.state,
        lastAgent: terminalStateRef.current.agent,
      });
    };
  }, [
    accessToken,
    apiBase,
    initialSession?.terminalState,
    notFound,
    onAuthExpired,
    terminalSessionId,
  ]);

  const isCommandActive = terminalState.state === "agent_running";

  useEffect(() => {
    if (activeTab === "chat") {
      rendererRef.current?.refresh();
    }
  }, [activeTab]);

  const handleStop = useCallback(() => {
    setImageError(null);
    aiDiagnosticLog("app terminal stop clicked", {
      terminalSessionId,
      stateAtClick: terminalStateRef.current.state,
      agentAtClick: terminalStateRef.current.agent,
    });
    void interruptTerminalSession(
      apiBase,
      accessToken,
      terminalSessionId,
    )
      .then(() => {
        aiDiagnosticLog("app terminal stop request succeeded", {
          terminalSessionId,
          stateAfterSuccess: terminalStateRef.current.state,
          agentAfterSuccess: terminalStateRef.current.agent,
        });
      })
      .catch((nextError: unknown) => {
      if (nextError instanceof ApiError && nextError.status === 401) {
        aiDiagnosticLog("app terminal stop request unauthorized", {
          terminalSessionId,
        });
        onAuthExpired();
        return;
      }
      aiDiagnosticLog("app terminal stop request failed", {
        terminalSessionId,
        stateAfterFailure: terminalStateRef.current.state,
        error: nextError instanceof Error ? nextError.message : String(nextError),
      });
      setImageError(
        nextError instanceof Error ? nextError.message : "中断命令失败",
      );
    });
  }, [accessToken, apiBase, onAuthExpired, terminalSessionId]);
  const handleSendCommand = useCallback(
    async (data: string): Promise<void> => {
      try {
        await sendTerminalInput(
          apiBase,
          accessToken,
          terminalSessionId,
          data,
          resolveComposerInputMode(terminalStateRef.current, data),
        );
      } catch (nextError: unknown) {
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
          return;
        }
        setImageError(
          nextError instanceof Error ? nextError.message : "命令发送失败",
        );
        throw nextError;
      }
    },
    [accessToken, apiBase, onAuthExpired, terminalSessionId],
  );
  const handlePickImage = useCallback(
    (file: File) => {
      setImageError(null);
      setIsPickingImage(true);
      void fileToBase64(file)
        .then((dataBase64) =>
          createTerminalSessionClipboardImage(
            apiBase,
            accessToken,
            terminalSessionId,
            {
              mimeType: file.type,
              dataBase64,
            },
          ),
        )
        .then((payload) => {
          sendInput(shellQuote(payload.filePath));
        })
        .catch((nextError: unknown) => {
          if (nextError instanceof ApiError && nextError.status === 401) {
            onAuthExpired();
            return;
          }
          setImageError(
            nextError instanceof Error ? nextError.message : "图片选择失败",
          );
        })
        .finally(() => {
          setIsPickingImage(false);
        });
    },
    [accessToken, apiBase, onAuthExpired, sendInput, terminalSessionId],
  );

  const handleShowChanges = useCallback((change: SelectedTerminalChange) => {
    setRequestedChange(change);
    setActiveTab("changes");
  }, []);

  return (
    <IonPage>
      <IonContent
        fullscreen
        scrollY={false}
        className="terminal-page bg-background text-foreground"
      >
        <main className="terminal-page-shell min-h-dvh bg-background">
          <header className="terminal-page-header border-border bg-card">
            <button
              aria-label="Back"
              className="terminal-page-header__button terminal-page-header__back"
              type="button"
              onClick={onBack}
            >
              <span aria-hidden="true" className="terminal-page-header__icon">
                ‹
              </span>
            </button>
            <div className="terminal-page-header__identity min-w-0">
              <div className="terminal-page-header__title-row">
                <h1 className="text-foreground">{title}</h1>
                <div className="terminal-page-header__meta text-muted-foreground">
                  <span
                    className={`terminal-page-header__status is-${connectionStatus}`}
                  >
                    {statusLabel}
                  </span>
                  {lastActivityAt ? (
                    <time dateTime={lastActivityAt}>
                      {formatRelativeTime(lastActivityAt)}
                    </time>
                  ) : null}
                </div>
              </div>
              <p className="text-muted-foreground">
                {subtitle || terminalSessionId}
              </p>
            </div>
            <button
              aria-label="Refresh terminal"
              className="terminal-page-header__button terminal-page-header__action"
              type="button"
              onClick={() => rendererRef.current?.refresh()}
            >
              <span aria-hidden="true" className="terminal-page-header__icon">
                ↻
              </span>
            </button>
          </header>
          <section className="terminal-page-body bg-background">
            {notFound ? (
              <div className="terminal-page-state">
                <IonText color="danger">{error}</IonText>
                <IonButton onClick={onBack}>返回首页</IonButton>
              </div>
            ) : (
              <>
                <div
                  aria-hidden={activeTab !== "chat"}
                  className={`terminal-tab-panel ${
                    activeTab === "chat" ? "is-active" : ""
                  }`}
                >
                  {connectionStatus === "connecting" && !metadata ? (
                    <div className="terminal-page-loading">
                      <IonSpinner name="crescent" />
                    </div>
                  ) : null}
                  {error ? (
                    <p className="terminal-page-error text-sm">{error}</p>
                  ) : null}
                  <TerminalRenderer
                    active={activeTab === "chat"}
                    className="terminal-page-renderer"
                    focusOnInteraction={false}
                    fontSize={12}
                    onInput={sendInput}
                    onResize={sendResize}
                    onTerminalReady={installTerminalTouchBehavior}
                    ref={rendererRef}
                    renderer="dom"
                    scrollbackLines={5000}
                  />
                </div>
                <div
                  aria-hidden={activeTab !== "changes"}
                  className={`terminal-tab-panel ${
                    activeTab === "changes" ? "is-active" : ""
                  }`}
                >
                  <TerminalChangesTab
                    accessToken={accessToken}
                    active={activeTab === "changes"}
                    apiBase={apiBase}
                    projectId={activeProjectId}
                    requestedChange={requestedChange}
                    onAuthExpired={onAuthExpired}
                    onChangesCount={setChangesCount}
                  />
                </div>
                <div
                  aria-hidden={activeTab !== "files"}
                  className={`terminal-tab-panel ${
                    activeTab === "files" ? "is-active" : ""
                  }`}
                >
                  <TerminalFilesTab
                    accessToken={accessToken}
                    active={activeTab === "files"}
                    apiBase={apiBase}
                    projectId={activeProjectId}
                    onAuthExpired={onAuthExpired}
                    onShowChanges={handleShowChanges}
                  />
                </div>
              </>
            )}
          </section>
          {activeTab === "chat" ? (
            <div className="terminal-composer-slot">
              {imageError ? (
                <p className="terminal-composer-error">{imageError}</p>
              ) : null}
              <TerminalCommandComposer
                disabled={notFound}
                isPickingImage={isPickingImage}
                isStopping={isCommandActive}
                onPickImage={handlePickImage}
                onSendInput={handleSendCommand}
                onStop={handleStop}
              />
            </div>
          ) : null}
          <TerminalDetailTabBar
            activeTab={activeTab}
            changesCount={changesCount}
            onTabChange={setActiveTab}
          />
        </main>
      </IonContent>
    </IonPage>
  );
}
