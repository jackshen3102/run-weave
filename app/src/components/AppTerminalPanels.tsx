import {
  TerminalRenderer,
  type TerminalRendererHandle,
} from "@browser-viewer/terminal-renderer";
import { IonButton, IonSpinner, IonText } from "@ionic/react";
import type { RefObject } from "react";

import { installTerminalTouchBehavior } from "../lib/app-terminal-touch-behavior";
import type { AppTerminalDetailTab } from "./TerminalDetailTabBar";
import {
  type SelectedTerminalChange,
  TerminalChangesTab,
} from "./TerminalChangesTab";
import { TerminalFilesTab } from "./TerminalFilesTab";

interface AppTerminalPanelsProps {
  accessToken: string;
  activeProjectId: string | null;
  activeTab: AppTerminalDetailTab;
  apiBase: string;
  connectionStatus: string;
  error: string | null;
  hasMetadata: boolean;
  isDeviceOffline: boolean;
  notFound: boolean;
  requestedChange: SelectedTerminalChange | null;
  rendererRef: RefObject<TerminalRendererHandle | null>;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  onAuthExpired: () => void;
  onBack: () => void;
  onChangesCount: (count: number) => void;
  onRefreshDeviceConnection: () => Promise<unknown>;
  onShowChanges: (change: SelectedTerminalChange) => void;
}

export function AppTerminalPanels({
  accessToken,
  activeProjectId,
  activeTab,
  apiBase,
  connectionStatus,
  error,
  hasMetadata,
  isDeviceOffline,
  notFound,
  onAuthExpired,
  onBack,
  onChangesCount,
  onRefreshDeviceConnection,
  onShowChanges,
  requestedChange,
  rendererRef,
  sendInput,
  sendResize,
}: AppTerminalPanelsProps) {
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
              onResize={sendResize}
              onTerminalReady={installTerminalTouchBehavior}
              ref={rendererRef}
              renderer="dom"
              scrollbackLines={5000}
            />
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
