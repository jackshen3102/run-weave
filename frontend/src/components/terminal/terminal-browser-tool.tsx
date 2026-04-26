import {
  ArrowLeft,
  ArrowRight,
  Code2,
  ExternalLink,
  Globe2,
  Plus,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { Button } from "../ui/button";

interface TerminalBrowserToolProps {
  active: boolean;
}

interface ElectronBrowserSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

const BROWSER_VIEW_GUTTER_PX = 6;

function browserTabLabel(title: string, url: string): string {
  return title.trim() || url.replace(/^https?:\/\//, "");
}

function openUrlExternally(url: string): void {
  if (window.electronAPI?.openExternal) {
    void window.electronAPI.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function TerminalBrowserTool({ active }: TerminalBrowserToolProps) {
  const tabs = useTerminalPreviewStore((state) => state.browser.tabs);
  const activeTabId = useTerminalPreviewStore(
    (state) => state.browser.activeTabId,
  );
  const createBrowserTab = useTerminalPreviewStore(
    (state) => state.createBrowserTab,
  );
  const closeBrowserTab = useTerminalPreviewStore(
    (state) => state.closeBrowserTab,
  );
  const setActiveBrowserTab = useTerminalPreviewStore(
    (state) => state.setActiveBrowserTab,
  );
  const updateBrowserTab = useTerminalPreviewStore(
    (state) => state.updateBrowserTab,
  );
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const loadedUrlByTabRef = useRef<Record<string, string>>({});
  const activeTabIdRef = useRef(activeTabId);
  const isElectron = window.electronAPI?.isElectron === true;
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );
  const activeTabUrl = activeTab?.url;

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const applyElectronSnapshot = useCallback(
    (tabId: string, snapshot: ElectronBrowserSnapshot) => {
      updateBrowserTab(tabId, {
        url: snapshot.url,
        addressInput: snapshot.url,
        title: snapshot.title || browserTabLabel("", snapshot.url),
        loading: false,
        canGoBack: snapshot.canGoBack,
        canGoForward: snapshot.canGoForward,
        error: undefined,
      });
    },
    [updateBrowserTab],
  );

  const syncBoundsForTab = useCallback(
    (tabId: string, immediate = false) => {
      if (!isElectron) {
        return;
      }

      const sendBounds = (): void => {
        frameRef.current = null;
        if (!active) {
          void window.electronAPI?.terminalBrowserHide?.(tabId);
          return;
        }
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          return;
        }
        void window.electronAPI?.terminalBrowserShow?.(tabId);
        void window.electronAPI?.terminalBrowserSetBounds?.(tabId, {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      };

      if (immediate) {
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        sendBounds();
        return;
      }

      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(sendBounds);
      }
    },
    [active, isElectron],
  );

  const syncBounds = useCallback(
    (immediate = false) => {
      if (!activeTabId) {
        return;
      }
      syncBoundsForTab(activeTabId, immediate);
    },
    [activeTabId, syncBoundsForTab],
  );

  const syncActiveTabBounds = useCallback(
    (tabId: string) => {
      if (activeTabIdRef.current === tabId) {
        syncBoundsForTab(tabId, true);
      }
    },
    [syncBoundsForTab],
  );

  const navigateTab = useCallback(
    async (tabId: string, rawInput: string): Promise<void> => {
      if (!tabId) {
        return;
      }
      const nextUrl = normalizeTerminalBrowserUrl(rawInput);
      if (!nextUrl.ok) {
        updateBrowserTab(tabId, {
          error: nextUrl.error,
          loading: false,
        });
        return;
      }

      updateBrowserTab(tabId, {
        url: nextUrl.url,
        addressInput: nextUrl.url,
        title: browserTabLabel("", nextUrl.url),
        loading: true,
        error: undefined,
      });

      if (!isElectron || !window.electronAPI?.terminalBrowserNavigate) {
        updateBrowserTab(tabId, { loading: false });
        return;
      }

      syncActiveTabBounds(tabId);

      try {
        loadedUrlByTabRef.current[tabId] = nextUrl.url;
        const snapshot = await window.electronAPI.terminalBrowserNavigate(
          tabId,
          nextUrl.url,
        );
        applyElectronSnapshot(tabId, snapshot);
        syncActiveTabBounds(tabId);
      } catch (error) {
        updateBrowserTab(tabId, {
          loading: false,
          error: error instanceof Error ? error.message : "Navigation failed",
        });
        syncActiveTabBounds(tabId);
      }
    },
    [
      applyElectronSnapshot,
      isElectron,
      syncActiveTabBounds,
      updateBrowserTab,
    ],
  );

  useEffect(() => {
    if (!activeTabId || !activeTabUrl || !active || !isElectron) {
      syncBounds(true);
      return;
    }

    if (loadedUrlByTabRef.current[activeTabId] !== activeTabUrl) {
      void navigateTab(activeTabId, activeTabUrl);
      return;
    }

    syncBounds(true);
  }, [active, activeTabId, activeTabUrl, isElectron, navigateTab, syncBounds]);

  useEffect(() => {
    if (!isElectron || !activeTabId) {
      return;
    }
    const element = surfaceRef.current;
    if (!element) {
      return;
    }
    const handleWindowResize = (): void => syncBounds();
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(element);
    window.addEventListener("resize", handleWindowResize);
    syncBounds(true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      void window.electronAPI?.terminalBrowserHide?.(activeTabId);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [activeTabId, isElectron, syncBounds]);

  if (!activeTab) {
    return null;
  }

  const submitAddress = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void navigateTab(activeTab.id, activeTab.addressInput);
  };

  const reload = async (): Promise<void> => {
    updateBrowserTab(activeTab.id, { loading: true, error: undefined });
    try {
      const snapshot = await window.electronAPI?.terminalBrowserReload?.(
        activeTab.id,
      );
      if (snapshot) {
        applyElectronSnapshot(activeTab.id, snapshot);
      } else {
        updateBrowserTab(activeTab.id, { loading: false });
      }
    } catch (error) {
      updateBrowserTab(activeTab.id, {
        loading: false,
        error: error instanceof Error ? error.message : "Reload failed",
      });
    }
  };

  const go = async (direction: "back" | "forward"): Promise<void> => {
    try {
      const snapshot =
        direction === "back"
          ? await window.electronAPI?.terminalBrowserGoBack?.(activeTab.id)
          : await window.electronAPI?.terminalBrowserGoForward?.(activeTab.id);
      if (snapshot) {
        applyElectronSnapshot(activeTab.id, snapshot);
      }
    } catch {
      return;
    }
  };

  const stop = (): void => {
    updateBrowserTab(activeTab.id, { loading: false });
    void window.electronAPI?.terminalBrowserStop?.(activeTab.id);
  };

  const closeTab = (event: ReactPointerEvent, tabId: string): void => {
    event.stopPropagation();
    void window.electronAPI?.terminalBrowserCloseTab?.(tabId);
    delete loadedUrlByTabRef.current[tabId];
    closeBrowserTab(tabId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <div
        className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Browser tabs"
      >
        {tabs.map((tab) => {
          const selected = tab.id === activeTab.id;
          return (
            <div
              key={tab.id}
              className={[
                "group flex h-7 max-w-[180px] shrink-0 items-center gap-1 rounded-md border px-2 text-xs",
                selected
                  ? "border-sky-500/60 bg-sky-500/15 text-slate-50"
                  : "border-slate-800 bg-slate-900/60 text-slate-300 hover:bg-slate-900",
              ].join(" ")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="flex min-w-0 flex-1 items-center gap-1"
                onClick={() => setActiveBrowserTab(tab.id)}
              >
                <Globe2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{browserTabLabel(tab.title, tab.url)}</span>
              </button>
              <button
                type="button"
                aria-label="Close browser tab"
                className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-700 hover:text-slate-100"
                onPointerDown={(event) => closeTab(event, tab.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 shrink-0 rounded-md px-0"
          aria-label="New browser tab"
          title="New browser tab"
          onClick={() => createBrowserTab()}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <form
        className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-800 px-2"
        onSubmit={submitAddress}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 rounded-md px-0"
          disabled={!isElectron || !activeTab.canGoBack}
          onClick={() => void go("back")}
          aria-label="Go back"
          title="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 rounded-md px-0"
          disabled={!isElectron || !activeTab.canGoForward}
          onClick={() => void go("forward")}
          aria-label="Go forward"
          title="Go forward"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 rounded-md px-0"
          onClick={activeTab.loading ? stop : () => void reload()}
          aria-label={activeTab.loading ? "Stop loading" : "Reload"}
          title={activeTab.loading ? "Stop loading" : "Reload"}
        >
          {activeTab.loading ? (
            <Square className="h-3.5 w-3.5" />
          ) : (
            <RotateCw className="h-4 w-4" />
          )}
        </Button>
        <input
          aria-label="Browser address"
          className="h-7 min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-900 px-2 text-xs text-slate-100 outline-none focus:border-sky-500"
          value={activeTab.addressInput}
          onChange={(event) =>
            updateBrowserTab(activeTab.id, { addressInput: event.target.value })
          }
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 rounded-md px-0"
          disabled={!isElectron}
          onClick={() => {
            void window.electronAPI?.terminalBrowserOpenDevTools?.(activeTab.id);
          }}
          aria-label="Open browser DevTools"
          title="Open browser DevTools"
        >
          <Code2 className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 rounded-md px-0"
          onClick={() => openUrlExternally(activeTab.url)}
          aria-label="Open in system browser"
          title="Open in system browser"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </form>
      {activeTab.error ? (
        <div className="border-b border-rose-900/60 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-300">
          {activeTab.error}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={surfaceRef}
          className="absolute inset-y-0 right-0"
          style={{ left: BROWSER_VIEW_GUTTER_PX }}
        />
        {!isElectron ? (
          <div
            className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-xs text-slate-400"
            style={{ left: BROWSER_VIEW_GUTTER_PX }}
          >
            <Globe2 className="h-8 w-8 text-slate-500" />
            <p>Local browser is available in the desktop app.</p>
            <Button
              type="button"
              size="sm"
              className="rounded-md"
              onClick={() => openUrlExternally(activeTab.url)}
            >
              Open in system browser
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
