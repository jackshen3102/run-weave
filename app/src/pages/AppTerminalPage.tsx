import type {
  TerminalMobileOverviewSession,
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

import { TerminalCommandComposer } from "../components/TerminalCommandComposer";
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
  initialSession?: TerminalMobileOverviewSession;
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

function installTerminalTouchBehavior({
  terminal,
  container,
}: TerminalRendererExtensionContext): { dispose(): void } {
  let lastTouchY: number | null = null;
  let accumulatedDelta = 0;
  let edgeSwipeActive = false;

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

  const handleTouchEnd = () => {
    lastTouchY = null;
    accumulatedDelta = 0;
    edgeSwipeActive = false;
  };

  container.addEventListener("pointerdown", suppressPointerFocus, {
    capture: true,
  });
  container.addEventListener("mousedown", suppressTerminalFocus, {
    capture: true,
  });
  container.addEventListener("click", suppressTerminalFocus, {
    capture: true,
  });
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

  return {
    dispose() {
      container.removeEventListener("pointerdown", suppressPointerFocus, {
        capture: true,
      });
      container.removeEventListener("mousedown", suppressTerminalFocus, {
        capture: true,
      });
      container.removeEventListener("click", suppressTerminalFocus, {
        capture: true,
      });
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
  const [imageError, setImageError] = useState<string | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [terminalState, setTerminalState] = useState<TerminalState>({
    state: "shell_idle",
    agent: null,
  });
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
  const lastActivityAt =
    metadata?.lastActivityAt ?? initialSession?.lastActivityAt;
  const statusLabel =
    connectionStatus === "connected"
      ? runtimeStatus === "exited"
        ? "Exited"
        : "Connected"
      : "Connecting";
  useEffect(() => {
    if (notFound) {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const refreshTerminalState = () => {
      void getCurrentTerminalState(apiBase, accessToken, terminalSessionId)
        .then((payload) => {
          if (!cancelled) {
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
            setTerminalState({ state: "shell_idle", agent: null });
            return;
          }
        });
    };

    refreshTerminalState();
    timer = window.setInterval(refreshTerminalState, 2000);

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearInterval(timer);
      }
    };
  }, [accessToken, apiBase, notFound, onAuthExpired, terminalSessionId]);

  const isCommandActive = terminalState.state === "agent_running";
  const handleStop = useCallback(() => {
    setImageError(null);
    void interruptTerminalSession(
      apiBase,
      accessToken,
      terminalSessionId,
    ).catch((nextError: unknown) => {
      if (nextError instanceof ApiError && nextError.status === 401) {
        onAuthExpired();
        return;
      }
      setImageError(
        nextError instanceof Error ? nextError.message : "中断命令失败",
      );
    });
  }, [accessToken, apiBase, onAuthExpired, terminalSessionId]);
  const handleSendCommand = useCallback(
    async (data: string): Promise<void> => {
      try {
        await sendTerminalInput(apiBase, accessToken, terminalSessionId, data);
      } catch (nextError: unknown) {
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
          return;
        }
        setImageError(
          nextError instanceof Error ? nextError.message : "命令发送失败",
        );
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

  return (
    <IonPage>
      <IonContent
        fullscreen
        scrollY={false}
        className="terminal-page bg-background text-foreground"
      >
        <main className="terminal-page-shell min-h-dvh bg-background">
          <header className="terminal-page-header border-border bg-card">
            <IonButton
              aria-label="Back"
              className="terminal-page-header__back"
              fill="clear"
              onClick={onBack}
            >
              ‹
            </IonButton>
            <div className="terminal-page-header__identity min-w-0">
              <h1 className="text-foreground">{title}</h1>
              <p className="text-muted-foreground">
                {subtitle || terminalSessionId}
              </p>
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
            <IonButton
              aria-label="Refresh terminal"
              className="terminal-page-header__action"
              fill="clear"
              onClick={() => rendererRef.current?.refresh()}
            >
              ↻
            </IonButton>
          </header>
          <section className="terminal-page-body bg-background">
            {notFound ? (
              <div className="terminal-page-state">
                <IonText color="danger">{error}</IonText>
                <IonButton onClick={onBack}>返回首页</IonButton>
              </div>
            ) : (
              <>
                {connectionStatus === "connecting" && !metadata ? (
                  <div className="terminal-page-loading">
                    <IonSpinner name="crescent" />
                  </div>
                ) : null}
                {error ? (
                  <p className="terminal-page-error text-sm">{error}</p>
                ) : null}
                <TerminalRenderer
                  active
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
              </>
            )}
          </section>
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
        </main>
      </IonContent>
    </IonPage>
  );
}
