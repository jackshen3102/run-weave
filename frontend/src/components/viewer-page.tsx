import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { ViewerTabList } from "./viewer/viewer-tab-list";
import { ViewerNavigationBar } from "./viewer/viewer-navigation-bar";
import { useViewerConnection } from "../features/viewer/use-viewer-connection";
import {
  buildDevtoolsPageUrl,
  normalizeNavigationUrl,
} from "../features/viewer/url";
import { useViewerInput } from "../features/viewer/use-viewer-input";

const HISTORY_GUARD_STATE_KEY = "__viewerHistoryGuard";

function toHistoryState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

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
  const inputBridgeRef = useRef<HTMLTextAreaElement>(null);
  const [addressInput, setAddressInput] = useState("");
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isNavigationBarOpen, setIsNavigationBarOpen] = useState(false);
  const {
    status,
    error,
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
    onBridgeKeyDown,
    onBridgeInput,
    onBridgeCompositionStart,
    onBridgeCompositionEnd,
  } = useViewerInput({
    canvasRef,
    inputBridgeRef,
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
  const isInspecting = canRenderDevtoolsControls && activeDevtoolsOpened;
  const canReconnect = status === "reconnecting" || status === "closed";

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

  const toggleInspectMode = (): void => {
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

  useEffect(() => {
    setIsMoreMenuOpen(false);
  }, [activeTabId, isInspecting]);

  useEffect(() => {
    if (!isMoreMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest("[data-viewer-more-menu-root='true']")) {
        return;
      }

      setIsMoreMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsMoreMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMoreMenuOpen]);

  useEffect(() => {
    const pushHistoryGuard = (): void => {
      const currentState = toHistoryState(window.history.state);
      window.history.pushState(
        {
          ...currentState,
          [HISTORY_GUARD_STATE_KEY]: true,
        },
        "",
        window.location.href,
      );
    };

    const handlePopState = (): void => {
      pushHistoryGuard();
    };

    if (
      toHistoryState(window.history.state)[HISTORY_GUARD_STATE_KEY] !== true
    ) {
      pushHistoryGuard();
    }
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  return (
    <main className="relative h-dvh overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(86,134,144,0.16),transparent_26%),radial-gradient(circle_at_bottom_right,rgba(170,150,115,0.14),transparent_28%)]" />
      <div className="relative mx-auto flex h-full w-full max-w-[1600px] flex-col">
        <textarea
          ref={inputBridgeRef}
          aria-label="Viewer input bridge"
          className="pointer-events-none fixed z-50 h-1 w-1 opacity-0"
          style={{ left: 0, top: 0 }}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={onBridgeKeyDown}
          onInput={onBridgeInput}
          onCompositionStart={onBridgeCompositionStart}
          onCompositionEnd={onBridgeCompositionEnd}
        />

        <section
          className={`animate-fade-rise relative flex flex-1 flex-col overflow-hidden border border-border/60 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.95)] transition-all duration-300 ease-out ${
            isInspecting ? "bg-[#050607]" : "bg-black/92"
          }`}
        >
          <div className="z-20 border-b border-white/10 bg-[rgba(9,14,21,0.84)] backdrop-blur-xl">
            <div className="w-full px-3 py-2 sm:px-4 sm:py-2.5">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full px-3 text-stone-300 hover:bg-white/8 hover:text-white"
                  onClick={() => window.location.assign("/")}
                >
                  Home
                </Button>

                <div className="min-w-0 flex-1">
                  <ViewerTabList
                    tabs={tabs}
                    onSwitchTab={(tabId) => {
                      sendInput({ type: "tab", action: "switch", tabId });
                    }}
                  />
                </div>

                <div
                  className="relative shrink-0"
                  data-viewer-more-menu-root="true"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full px-3 text-stone-300 hover:bg-white/8 hover:text-white"
                    aria-label="More actions"
                    onClick={() => {
                      setIsMoreMenuOpen((open) => !open);
                    }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                  {isMoreMenuOpen && (
                    <div className="animate-scale-fade absolute right-0 top-11 z-20 min-w-44 rounded-2xl border border-white/10 bg-[rgba(12,17,25,0.94)] p-2 shadow-[0_20px_50px_-30px_rgba(0,0,0,0.8)] backdrop-blur-xl">
                      {!isInspecting && (
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-stone-200 transition hover:bg-white/8"
                          onClick={() => {
                            setIsMoreMenuOpen(false);
                            setIsNavigationBarOpen((open) => !open);
                          }}
                        >
                          {isNavigationBarOpen ? (
                            <ChevronUp className="h-4 w-4 text-stone-400" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-stone-400" />
                          )}
                          {isNavigationBarOpen
                            ? "Hide address bar"
                            : "Show address bar"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-stone-200 transition hover:bg-white/8"
                        onClick={() => {
                          setIsMoreMenuOpen(false);
                          sendInput({ type: "tab", action: "create" });
                        }}
                      >
                        <Plus className="h-4 w-4 text-stone-400" />
                        New tab
                      </button>
                      {activeTabId && (
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-stone-200 transition hover:bg-white/8"
                          onClick={() => {
                            setIsMoreMenuOpen(false);
                            sendInput({
                              type: "tab",
                              action: "close",
                              tabId: activeTabId,
                            });
                          }}
                        >
                          <X className="h-4 w-4 text-stone-400" />
                          Close tab
                        </button>
                      )}
                      {canReconnect && (
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-stone-200 transition hover:bg-white/8"
                          onClick={() => {
                            setIsMoreMenuOpen(false);
                            reconnect();
                          }}
                        >
                          <RotateCw className="h-4 w-4 text-stone-400" />
                          Reconnect
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {canRenderDevtoolsControls && (
                  <Button
                    size="sm"
                    variant={isInspecting ? "secondary" : "default"}
                    className="rounded-full px-4 transition-all duration-300 ease-out"
                    onClick={toggleInspectMode}
                  >
                    {isInspecting ? "Page" : "Inspect"}
                  </Button>
                )}
              </div>

              {isNavigationBarOpen && !isInspecting && (
                <div
                  className="mt-2 border-t border-white/10 pt-2"
                  data-testid="navigation-bar"
                >
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
                </div>
              )}

              {(status !== "connected" || error) && (
                <div className="mt-2 px-1 text-xs text-amber-300">
                  {error ??
                    (status === "reconnecting" ? "Reconnecting..." : status)}
                </div>
              )}
            </div>
          </div>

          {activeTabId === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-stone-300/80">
              Open a new tab to begin.
            </div>
          ) : (
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <div
                className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${
                  isInspecting ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
              >
                <canvas
                  ref={canvasRef}
                  className="h-full w-auto max-w-full transition-opacity duration-300"
                  style={{ touchAction: "none" }}
                  tabIndex={isInspecting ? -1 : 0}
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onWheel={onWheel}
                  onContextMenu={onContextMenu}
                  onMouseLeave={onMouseLeave}
                />
              </div>

              {isInspecting && (
                <>
                  <div className="pointer-events-none absolute left-5 top-3 z-10 rounded-full border border-white/15 bg-black/42 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-white/72 shadow-[0_12px_40px_-20px_rgba(0,0,0,0.8)]">
                    Inspector
                  </div>
                  <iframe
                    key={activeTabId}
                    title="DevTools"
                    src={buildDevtoolsPageUrl(
                      apiBase,
                      sessionId,
                      token,
                      activeTabId,
                    )}
                    className="absolute inset-0 h-full w-full bg-[#050607] transition-opacity duration-300"
                    sandbox="allow-scripts allow-same-origin"
                  />
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
