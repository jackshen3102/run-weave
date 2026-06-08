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
import { useMemo, useRef } from "react";

import { TerminalCommandComposer } from "../components/TerminalCommandComposer";
import { formatRelativeTime } from "../lib/terminal-home-view-model";
import { useAppTerminalConnection } from "../hooks/use-app-terminal-connection";

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
    : initialSession?.subtitle ?? "";
  const lastActivityAt = metadata?.lastActivityAt ?? initialSession?.lastActivityAt;
  const statusLabel =
    connectionStatus === "connected"
      ? runtimeStatus === "exited"
        ? "Exited"
        : "Connected"
      : "Connecting";

  return (
    <IonPage>
      <IonContent fullscreen scrollY={false} className="terminal-page">
        <main className="terminal-page-shell">
          <header className="terminal-page-header">
            <IonButton
              aria-label="Back"
              className="terminal-page-header__back"
              fill="clear"
              onClick={onBack}
            >
              ‹
            </IonButton>
            <div className="terminal-page-header__identity">
              <h1>{title}</h1>
              <p>{subtitle || terminalSessionId}</p>
              <div className="terminal-page-header__meta">
                <span className={`terminal-page-header__status is-${connectionStatus}`}>
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
          <section className="terminal-page-body">
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
                {error ? <p className="terminal-page-error">{error}</p> : null}
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
          <TerminalCommandComposer disabled={notFound} onSendInput={sendInput} />
        </main>
      </IonContent>
    </IonPage>
  );
}
