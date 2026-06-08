import type { TerminalMobileOverviewSession } from "@browser-viewer/shared";
import {
  TerminalRenderer,
  type TerminalRendererHandle,
} from "@browser-viewer/terminal-renderer";
import {
  IonButton,
  IonContent,
  IonPage,
  IonSpinner,
  IonText,
} from "@ionic/react";
import { useCallback, useMemo, useRef, useState } from "react";

import { TerminalCommandComposer } from "../components/TerminalCommandComposer";
import { fileToBase64, shellQuote } from "../lib/terminal-input-assets";
import { formatRelativeTime } from "../lib/terminal-home-view-model";
import { useAppTerminalConnection } from "../hooks/use-app-terminal-connection";
import { ApiError } from "../services/http";
import { createTerminalSessionClipboardImage } from "../services/terminal";

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
  const {
    connectionStatus,
    error,
    metadata,
    notFound,
    runtimeStatus,
    sendInput,
    sendResize,
    sendSignal,
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
  const isCommandActive =
    connectionStatus === "connected" &&
    runtimeStatus === "running" &&
    Boolean(metadata?.activeCommand);
  const handleStop = useCallback(() => {
    sendSignal("SIGINT");
  }, [sendSignal]);
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
                  fontSize={12}
                  onInput={sendInput}
                  onResize={sendResize}
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
            onSendInput={sendInput}
            onStop={handleStop}
          />
        </main>
      </IonContent>
    </IonPage>
  );
}
