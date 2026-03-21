import { useEffect, useRef, useState } from "react";
import { ViewerHeader } from "./viewer/viewer-header";
import { ViewerTabList } from "./viewer/viewer-tab-list";
import { ViewerNavigationBar } from "./viewer/viewer-navigation-bar";
import { useViewerConnection } from "../features/viewer/use-viewer-connection";
import { buildDevtoolsPageUrl, normalizeNavigationUrl } from "../features/viewer/url";
import { useViewerInput } from "../features/viewer/use-viewer-input";

interface ViewerPageProps {
  apiBase: string;
  sessionId: string;
  token: string;
  onAuthExpired?: () => void;
}

export function ViewerPage({
  apiBase,
  sessionId,
  token,
  onAuthExpired,
}: ViewerPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [addressInput, setAddressInput] = useState("");
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const {
    status,
    error,
    sentCount,
    ackCount,
    tabs,
    navigationByTabId,
    devtoolsEnabled,
    devtoolsByTabId,
    sendInput,
    reconnect,
  } = useViewerConnection({
    apiBase,
    sessionId,
    token,
    onAuthExpired,
    canvasRef,
  });
  const {
    onMouseDown,
    onMouseMove,
    onWheel,
    onContextMenu,
    onMouseLeave,
    onKeyDown,
  } = useViewerInput({
    canvasRef,
    sendInput,
  });

  const activeTabId = tabs.find((tab) => tab.active)?.id ?? null;
  const activeNavigation = activeTabId
    ? navigationByTabId[activeTabId]
    : undefined;
  const activeDevtoolsOpened = activeTabId
    ? (devtoolsByTabId[activeTabId] ?? false)
    : false;
  const canRenderDevtoolsControls = devtoolsEnabled && activeTabId !== null;
  const shouldRenderDevtoolsFrame = canRenderDevtoolsControls && activeDevtoolsOpened;

  const submitNavigation = (): void => {
    if (!activeTabId) {
      return;
    }
    const normalizedUrl = normalizeNavigationUrl(addressInput);
    if (!normalizedUrl) {
      return;
    }

    setAddressInput(normalizedUrl);
    setIsEditingAddress(false);
    sendInput({
      type: "navigation",
      action: "goto",
      tabId: activeTabId,
      url: normalizedUrl,
    });
  };

  const submitTabNavigationAction = (
    action: "back" | "forward" | "reload" | "stop",
  ): void => {
    if (!activeTabId) {
      return;
    }
    sendInput({
      type: "navigation",
      action,
      tabId: activeTabId,
    });
  };

  const toggleDevtools = (): void => {
    if (!activeTabId) {
      return;
    }
    sendInput({
      type: "devtools",
      action: activeDevtoolsOpened ? "close" : "open",
      tabId: activeTabId,
    });
  };

  useEffect(() => {
    if (isEditingAddress) {
      return;
    }
    setAddressInput(activeNavigation?.url ?? "");
  }, [activeNavigation?.url, isEditingAddress]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 sm:p-8">
      <ViewerHeader
        sessionId={sessionId}
        status={status}
        canReconnect={status === "reconnecting" || status === "closed"}
        onReconnect={reconnect}
        onBack={() => window.location.assign("/")}
      />

      <section className="rounded-xl border border-border/80 bg-card/70 p-3 backdrop-blur">
        {canRenderDevtoolsControls && (
          <div className="mb-3 flex items-center justify-end">
            <button
              type="button"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md bg-muted px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:opacity-90"
              onClick={toggleDevtools}
            >
              {activeDevtoolsOpened ? "Close DevTools" : "Open DevTools"}
            </button>
          </div>
        )}

        <ViewerTabList
          tabs={tabs}
          onSwitchTab={(tabId) => {
            sendInput({ type: "tab", action: "switch", tabId });
          }}
        />

        <ViewerNavigationBar
          activeTabId={activeTabId}
          activeNavigation={activeNavigation}
          addressInput={addressInput}
          onAddressFocus={() => setIsEditingAddress(true)}
          onAddressChange={setAddressInput}
          onAddressBlur={() => {
            setIsEditingAddress(false);
            setAddressInput(activeNavigation?.url ?? "");
          }}
          onAddressSubmit={submitNavigation}
          onAddressCancel={() => {
            setIsEditingAddress(false);
            setAddressInput(activeNavigation?.url ?? "");
          }}
          onNavigationAction={submitTabNavigationAction}
        />

        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
        {status === "reconnecting" && !error && (
          <p className="mb-3 text-sm text-amber-600">
            Connection lost, trying to reconnect...
          </p>
        )}
        <p
          className="mb-2 text-xs text-muted-foreground"
          data-testid="ws-stats"
        >
          Sent: {sentCount} | Ack: {ackCount}
        </p>
        <div className="overflow-hidden rounded-md border border-border bg-black/70">
          <canvas
            ref={canvasRef}
            className="h-auto w-full"
            style={{ touchAction: "none" }}
            tabIndex={0}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onWheel={onWheel}
            onContextMenu={onContextMenu}
            onMouseLeave={onMouseLeave}
            onKeyDown={onKeyDown}
          />
        </div>

        {shouldRenderDevtoolsFrame && activeTabId && (
          <div className="mt-3 overflow-hidden rounded-md border border-border bg-black/80">
            <iframe
              key={activeTabId}
              title="DevTools"
              src={buildDevtoolsPageUrl(apiBase, sessionId, token, activeTabId)}
              className="h-[420px] w-full"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        )}
      </section>
    </main>
  );
}
