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
import { HttpError } from "../services/http";
import {
  createAiBridge,
  createDevtoolsTicket,
  revokeAiBridge,
} from "../services/session";

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
  onHome?: () => void;
}

export function ViewerPage({
  apiBase,
  sessionId,
  token,
  onAuthExpired,
  onHome,
}: ViewerPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputBridgeRef = useRef<HTMLTextAreaElement>(null);
  const tokenRef = useRef(token);
  const [addressInput, setAddressInput] = useState("");
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isNavigationBarOpen, setIsNavigationBarOpen] = useState(false);
  const [devtoolsUrl, setDevtoolsUrl] = useState<string | null>(null);
  const [devtoolsError, setDevtoolsError] = useState<string | null>(null);
  const [aiBridgeUrl, setAiBridgeUrl] = useState<string | null>(null);
  const [aiBridgeError, setAiBridgeError] = useState<string | null>(null);
  const [aiBridgeLoading, setAiBridgeLoading] = useState(false);
  const {
    status,
    error,
    tabs,
    navigationByTabId,
    devtoolsEnabled,
    devtoolsByTabId,
    collaboration,
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
  const aiAssistEnabled = collaboration.aiStatus !== "idle";

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

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

  const toggleAiAssist = (): void => {
    if (aiBridgeLoading) {
      return;
    }

    setAiBridgeLoading(true);
    setAiBridgeError(null);

    const request = aiAssistEnabled
      ? revokeAiBridge(apiBase, token, sessionId).then(() => {
          setAiBridgeUrl(null);
        })
      : createAiBridge(apiBase, token, sessionId, {
          tabId: activeTabId ?? undefined,
        }).then((payload) => {
          setAiBridgeUrl(payload.bridgeUrl);
        });

    void request
      .catch((currentError: unknown) => {
        if (currentError instanceof HttpError && currentError.status === 401) {
          onAuthExpired?.();
          return;
        }
        setAiBridgeError("Failed to update AI bridge.");
        console.error("[viewer-fe] failed to update ai bridge", {
          sessionId,
          error: String(currentError),
        });
      })
      .finally(() => {
        setAiBridgeLoading(false);
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
    if (collaboration.aiStatus === "idle") {
      setAiBridgeUrl(null);
    }
  }, [collaboration.aiStatus]);

  useEffect(() => {
    if (!isInspecting || !activeTabId) {
      setDevtoolsUrl(null);
      setDevtoolsError(null);
      return;
    }

    let cancelled = false;
    setDevtoolsUrl(null);
    setDevtoolsError(null);

    void createDevtoolsTicket(apiBase, tokenRef.current, sessionId, {
      tabId: activeTabId,
    })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setDevtoolsUrl(
          buildDevtoolsPageUrl(
            apiBase,
            sessionId,
            activeTabId,
            payload.ticket,
          ),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
          return;
        }
        setDevtoolsError("Failed to load DevTools.");
        console.error("[viewer-fe] failed to load devtools shell", {
          sessionId,
          tabId: activeTabId,
          error: String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeTabId, apiBase, isInspecting, onAuthExpired, sessionId]);

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
      <div className="relative mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3 p-3">
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

        <div className="min-h-0 flex flex-1">
          <section
            className={`animate-fade-rise relative min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden border border-border/60 bg-black/92 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.95)] transition-all duration-300 ease-out ${
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
                    onClick={() => {
                      if (onHome) {
                        onHome();
                        return;
                      }
                      window.location.assign("/");
                    }}
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

                  <Button
                    size="sm"
                    variant={aiAssistEnabled ? "secondary" : "ghost"}
                    className="rounded-full px-4 transition-all duration-300 ease-out"
                    onClick={toggleAiAssist}
                    disabled={aiBridgeLoading}
                  >
                    {aiBridgeLoading
                      ? "Updating..."
                      : aiAssistEnabled
                        ? "Disable AI"
                        : "AI Assist"}
                  </Button>
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

                <div className="mt-2 px-1 text-xs text-stone-300/80">
                  AI {collaboration.aiStatus}
                  {collaboration.controlOwner !== "none"
                    ? ` · owner ${collaboration.controlOwner}`
                    : ""}
                  {collaboration.collaborationTabId
                    ? ` · tab ${collaboration.collaborationTabId}`
                    : ""}
                </div>

                {collaboration.aiLastAction && (
                  <div className="mt-1 px-1 text-xs text-stone-300/72">
                    Last AI action: {collaboration.aiLastAction}
                  </div>
                )}

                {(aiBridgeUrl || aiBridgeError || collaboration.aiLastError) && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 px-1 text-xs">
                    {aiBridgeUrl && (
                      <button
                        type="button"
                        className="rounded-full border border-white/12 px-2 py-1 text-stone-200 transition hover:bg-white/8"
                        onClick={() => {
                          void navigator.clipboard?.writeText(aiBridgeUrl);
                        }}
                      >
                        Copy AI bridge URL
                      </button>
                    )}
                    {aiBridgeError ? (
                      <span className="text-amber-300">{aiBridgeError}</span>
                    ) : null}
                    {collaboration.aiLastError ? (
                      <span className="text-amber-300">
                        {collaboration.aiLastError}
                      </span>
                    ) : null}
                  </div>
                )}

                {isInspecting && devtoolsError && (
                  <div className="mt-2 px-1 text-xs text-amber-300">
                    {devtoolsError}
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
                    isInspecting
                      ? "pointer-events-none opacity-0"
                      : "opacity-100"
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
                    {devtoolsUrl ? (
                      <iframe
                        key={activeTabId}
                        title="DevTools"
                        src={devtoolsUrl}
                        className="absolute inset-0 h-full w-full bg-[#050607] transition-opacity duration-300"
                      />
                    ) : null}
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
