import { useMemoizedFn } from "ahooks";
import {
  TerminalRenderer,
  type TerminalRendererExtensionContext,
  type TerminalRendererHandle,
} from "@runweave/terminal-renderer";
import { IonButton, IonIcon, IonSpinner, IonText } from "@ionic/react";
import { arrowDownOutline } from "ionicons/icons";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { installTerminalTouchBehavior } from "../lib/app-terminal-touch-behavior";
import { sendTerminalInput as sendTerminalInputRequest } from "../services/terminal";
import type { SelectedTerminalChange } from "./TerminalChangesTab";
import { useAppTerminalUiStore } from "../store/use-app-terminal-ui-store";
import { recordSupportLog } from "../features/support-logs";
import { useAppTerminalRuntime } from "../features/terminal/app-terminal-runtime";

const TMUX_SCROLL_BUTTON_REVEAL_THRESHOLD_ROWS = 4;
const LazyTerminalChangesTab = lazy(async () => {
  const module = await import("./TerminalChangesTab");
  return { default: module.TerminalChangesTab };
});
const LazyTerminalFilesTab = lazy(async () => {
  const module = await import("./TerminalFilesTab");
  return { default: module.TerminalFilesTab };
});

function TerminalTabLoading() {
  return (
    <div className="terminal-page-state">
      <IonSpinner name="crescent" />
    </div>
  );
}

interface AppTerminalConnectionState {
  connectionStatus: string;
  error: string | null;
  hasMetadata: boolean;
  isDeviceOffline: boolean;
  notFound: boolean;
  onBack: () => void;
  onRefresh: () => Promise<unknown>;
}

interface AppTerminalRendererController {
  rendererRef: RefObject<TerminalRendererHandle | null>;
  runtimeKind: "tmux" | "pty" | null;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  onReady: () => void;
}

interface AppTerminalPanelsProps {
  connection: AppTerminalConnectionState;
  renderer: AppTerminalRendererController;
}

export function AppTerminalPanels({
  connection,
  renderer,
}: AppTerminalPanelsProps) {
  const {
    connectionStatus,
    error,
    hasMetadata,
    isDeviceOffline,
    notFound,
    onBack,
    onRefresh: onRefreshDeviceConnection,
  } = connection;
  const {
    onReady: onTerminalReady,
    rendererRef,
    runtimeKind,
    sendInput,
    sendResize,
  } = renderer;
  const { accessToken, apiBase, terminalSessionId } = useAppTerminalRuntime();
  const activeTab = useAppTerminalUiStore((state) => state.activeTab);
  const requestedChange = useAppTerminalUiStore(
    (state) => state.requestedChange,
  );
  const setChangesCount = useAppTerminalUiStore(
    (state) => state.setChangesCount,
  );
  const showChanges = useAppTerminalUiStore((state) => state.showChanges);
  const handleShowChanges = useMemoizedFn((change: SelectedTerminalChange) => {
    recordSupportLog("terminal.tab.changed", {
      terminalSessionId,
      previousTab: activeTab,
      nextTab: "changes",
    });
    showChanges(change);
  });
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

  const handleTmuxScrollbackDistanceChange = useMemoizedFn(
    (deltaRows: number) => {
      const nextDistanceRows = Math.max(
        0,
        tmuxScrollbackDistanceRowsRef.current + deltaRows,
      );
      tmuxScrollbackDistanceRowsRef.current = nextDistanceRows;
      setTmuxScrollbackActive(
        nextDistanceRows >= TMUX_SCROLL_BUTTON_REVEAL_THRESHOLD_ROWS,
      );
    },
  );

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

  const handleTerminalBottomStateChange = useMemoizedFn(
    (isAtBottom: boolean) => {
      setTerminalAtBottom(isAtBottom);
      if (isAtBottom) {
        resetTmuxScrollbackDistance();
      }
    },
  );

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
          {activeTab === "changes" ? (
            <div className="terminal-tab-panel is-active">
              <Suspense fallback={<TerminalTabLoading />}>
                <LazyTerminalChangesTab
                  active
                  requestedChange={requestedChange}
                  onChangesCount={setChangesCount}
                />
              </Suspense>
            </div>
          ) : null}
          {activeTab === "files" ? (
            <div className="terminal-tab-panel is-active">
              <Suspense fallback={<TerminalTabLoading />}>
                <LazyTerminalFilesTab
                  active
                  onShowChanges={handleShowChanges}
                />
              </Suspense>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
