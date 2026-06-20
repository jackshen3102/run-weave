import { useMemoizedFn } from "ahooks";
import {
  TerminalRenderer,
  type TerminalRendererExtensionContext,
  type TerminalRendererHandle,
} from "@runweave/terminal-renderer";
import { IonButton, IonIcon, IonSpinner, IonText } from "@ionic/react";
import { arrowDownOutline } from "ionicons/icons";
import { useEffect, useRef, useState, type RefObject } from "react";

import { installTerminalTouchBehavior } from "../lib/app-terminal-touch-behavior";
import { sendTerminalInput as sendTerminalInputRequest } from "../services/terminal";
import type { AppTerminalDetailTab } from "./TerminalDetailTabBar";
import {
  type SelectedTerminalChange,
  TerminalChangesTab,
} from "./TerminalChangesTab";
import { TerminalFilesTab } from "./TerminalFilesTab";

const TMUX_SCROLL_BUTTON_REVEAL_THRESHOLD_ROWS = 4;

interface AppTerminalPanelsProps {
  accessToken: string;
  activeProjectId: string | null;
  activeTab: AppTerminalDetailTab;
  apiBase: string;
  terminalSessionId: string;
  connectionStatus: string;
  error: string | null;
  hasMetadata: boolean;
  isDeviceOffline: boolean;
  notFound: boolean;
  requestedChange: SelectedTerminalChange | null;
  rendererRef: RefObject<TerminalRendererHandle | null>;
  runtimeKind: "tmux" | "pty" | null;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  onAuthExpired: () => void;
  onBack: () => void;
  onChangesCount: (count: number) => void;
  onTerminalReady: () => void;
  onRefreshDeviceConnection: () => Promise<unknown>;
  onShowChanges: (change: SelectedTerminalChange) => void;
}

export function AppTerminalPanels({
  accessToken,
  activeProjectId,
  activeTab,
  apiBase,
  terminalSessionId,
  connectionStatus,
  error,
  hasMetadata,
  isDeviceOffline,
  notFound,
  onAuthExpired,
  onBack,
  onChangesCount,
  onTerminalReady,
  onRefreshDeviceConnection,
  onShowChanges,
  requestedChange,
  rendererRef,
  runtimeKind,
  sendInput,
  sendResize,
}: AppTerminalPanelsProps) {
  // The touch behavior is installed once on terminal ready; refs let it read
  // the latest runtimeKind and input sender without reinstalling.
  const runtimeKindRef = useRef(runtimeKind);
  const sendInputRef = useRef(sendInput);
  const tmuxScrollbackDistanceRowsRef = useRef(0);
  const [terminalAtBottom, setTerminalAtBottom] = useState(true);
  const [tmuxScrollbackActive, setTmuxScrollbackActive] = useState(false);
  useEffect(() => {
    runtimeKindRef.current = runtimeKind;
  }, [runtimeKind]);
  useEffect(() => {
    sendInputRef.current = sendInput;
  }, [sendInput]);

  const resetTmuxScrollbackDistance = useMemoizedFn(() => {
    tmuxScrollbackDistanceRowsRef.current = 0;
    setTmuxScrollbackActive(false);
  });

  const handleTmuxScrollbackDistanceChange = useMemoizedFn((deltaRows: number) => {
    const nextDistanceRows = Math.max(
      0,
      tmuxScrollbackDistanceRowsRef.current + deltaRows,
    );
    tmuxScrollbackDistanceRowsRef.current = nextDistanceRows;
    setTmuxScrollbackActive(
      nextDistanceRows >= TMUX_SCROLL_BUTTON_REVEAL_THRESHOLD_ROWS,
    );
  });

  const handleTerminalReady = useMemoizedFn(
    (context: TerminalRendererExtensionContext) => {
      const disposable = installTerminalTouchBehavior(context, {
        getRuntimeKind: () => runtimeKindRef.current,
        onTmuxScrollbackDistanceChange: handleTmuxScrollbackDistanceChange,
        sendInput: (data) => sendInputRef.current(data),
      });
      onTerminalReady();
      return disposable;
    },
  );

  const handleTerminalBottomStateChange = useMemoizedFn((isAtBottom: boolean) => {
    setTerminalAtBottom(isAtBottom);
    if (isAtBottom) {
      resetTmuxScrollbackDistance();
    }
  });

  const requestTmuxExitCopyMode = useMemoizedFn(() => {
    const sendExitRequest = () => {
      void sendTerminalInputRequest(
        apiBase,
        accessToken,
        terminalSessionId,
        "",
        "tmux_exit_copy_mode",
      );
    };

    sendExitRequest();
    window.setTimeout(sendExitRequest, 250);
    window.setTimeout(sendExitRequest, 800);
  });

  const handleScrollToBottom = useMemoizedFn(() => {
    if (tmuxScrollbackActive) {
      requestTmuxExitCopyMode();
    }
    resetTmuxScrollbackDistance();
    setTerminalAtBottom(true);
    rendererRef.current?.scrollToBottom();
  });

  return (
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
            className={`terminal-tab-panel ${activeTab === "chat" ? "is-active" : ""}`}
          >
            {connectionStatus === "connecting" && !hasMetadata ? (
              <div className="terminal-page-loading">
                <IonSpinner name="crescent" />
              </div>
            ) : null}
            {error ? (
              <p className="terminal-page-error text-sm">{error}</p>
            ) : null}
            {isDeviceOffline ? (
              <div className="terminal-page-offline">
                <span>本地电脑暂时不可用，恢复后会自动重连。</span>
                <button
                  type="button"
                  onClick={() => {
                    void onRefreshDeviceConnection();
                  }}
                >
                  重试
                </button>
              </div>
            ) : null}
            <TerminalRenderer
              active={activeTab === "chat"}
              className="terminal-page-renderer"
              focusOnInteraction={false}
              fontSize={12}
              onInput={sendInput}
              onBottomStateChange={handleTerminalBottomStateChange}
              onResize={sendResize}
              onTerminalReady={handleTerminalReady}
              ref={rendererRef}
              renderer="dom"
              scrollbackLines={5000}
            />
            {!terminalAtBottom || tmuxScrollbackActive ? (
              <button
                type="button"
                aria-label="Scroll terminal to bottom"
                title="Scroll to bottom"
                className="terminal-scroll-bottom-button"
                onPointerDown={(event) => {
                  event.preventDefault();
                }}
                onClick={handleScrollToBottom}
              >
                <IonIcon aria-hidden="true" icon={arrowDownOutline} />
              </button>
            ) : null}
          </div>
          <div
            aria-hidden={activeTab !== "changes"}
            className={`terminal-tab-panel ${activeTab === "changes" ? "is-active" : ""}`}
          >
            <TerminalChangesTab
              accessToken={accessToken}
              active={activeTab === "changes"}
              apiBase={apiBase}
              projectId={activeProjectId}
              requestedChange={requestedChange}
              onAuthExpired={onAuthExpired}
              onChangesCount={onChangesCount}
            />
          </div>
          <div
            aria-hidden={activeTab !== "files"}
            className={`terminal-tab-panel ${activeTab === "files" ? "is-active" : ""}`}
          >
            <TerminalFilesTab
              accessToken={accessToken}
              active={activeTab === "files"}
              apiBase={apiBase}
              projectId={activeProjectId}
              onAuthExpired={onAuthExpired}
              onShowChanges={onShowChanges}
            />
          </div>
        </>
      )}
    </section>
  );
}
