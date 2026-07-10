import { useMemoizedFn } from "ahooks";
import { Globe2, LoaderCircle, Plus, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TerminalBrowserTabState } from "../../features/terminal/preview-store";
import {
  SortableTabs,
  type SortableTabRenderProps,
} from "../ui/sortable-tabs";
import { TerminalBrowserTabOverview } from "./terminal-browser-tab-overview";
import {
  TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH,
  TERMINAL_BROWSER_INACTIVE_TAB_MIN_WIDTH,
  TERMINAL_BROWSER_TAB_PREFERRED_WIDTH,
  browserTabLabel,
  calculateTerminalBrowserTabWidths,
  getBrowserGroupColor,
  getBrowserGroupLabel,
  getTerminalBrowserTabDensity,
} from "./terminal-browser-tab-utils";

interface TerminalBrowserTabsProps {
  tabs: TerminalBrowserTabState[];
  activeTabId: string;
  onCreateTab: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (
    event: { stopPropagation: () => void },
    tabId: string,
  ) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

function BrowserGroupMarker({ browserGroupId }: { browserGroupId?: string }) {
  const style: CSSProperties = {
    backgroundColor: getBrowserGroupColor(browserGroupId),
  };
  return (
    <span
      className="h-4 w-1.5 shrink-0 rounded-full"
      style={style}
      title={getBrowserGroupLabel(browserGroupId)}
      aria-hidden="true"
    />
  );
}

function equalTabIdOrder(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((tabId, index) => tabId === right[index])
  );
}

export function TerminalBrowserTabs({
  tabs,
  activeTabId,
  onCreateTab,
  onSelectTab,
  onCloseTab,
  onReorder,
}: TerminalBrowserTabsProps) {
  const [now, setNow] = useState(() => Date.now());
  const [viewportWidth, setViewportWidth] = useState(0);
  const [frozenWidths, setFrozenWidths] = useState<Record<string, number> | null>(
    null,
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef(new Map<string, HTMLDivElement>());
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const closeFreezeTimerRef = useRef<number | null>(null);
  const closePointerTypeRef = useRef<string | null>(null);
  const pendingClosedTabIdRef = useRef<string | null>(null);
  const previousTabIdsRef = useRef(tabs.map((tab) => tab.id));
  const lastViewportWidthRef = useRef(0);
  const nextScrollBehaviorRef = useRef<ScrollBehavior>("auto");
  const pendingFocusTabIdRef = useRef<string | null>(null);
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const tabIdsKey = tabIds.join("\u0000");
  const calculatedWidths = useMemo(
    () =>
      calculateTerminalBrowserTabWidths(
        tabs,
        activeTabId,
        viewportWidth || TERMINAL_BROWSER_TAB_PREFERRED_WIDTH * tabs.length,
      ),
    [activeTabId, tabs, viewportWidth],
  );
  const widthByTabId = useMemo(() => {
    if (!frozenWidths) {
      return calculatedWidths;
    }
    return Object.fromEntries(
      tabs.map((tab) => {
        const minimum =
          tab.id === activeTabId
            ? TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH
            : TERMINAL_BROWSER_INACTIVE_TAB_MIN_WIDTH;
        return [
          tab.id,
          Math.max(frozenWidths[tab.id] ?? calculatedWidths[tab.id]!, minimum),
        ];
      }),
    );
  }, [activeTabId, calculatedWidths, frozenWidths, tabs]);
  const hasActiveMcpActivity = tabs.some(
    (tab) => typeof tab.mcpActivityUntil === "number" && tab.mcpActivityUntil > now,
  );

  const clearCloseFreeze = useMemoizedFn(() => {
    if (closeFreezeTimerRef.current !== null) {
      window.clearTimeout(closeFreezeTimerRef.current);
      closeFreezeTimerRef.current = null;
    }
    closePointerTypeRef.current = null;
    pendingClosedTabIdRef.current = null;
    setFrozenWidths(null);
  });

  useEffect(() => {
    if (!hasActiveMcpActivity) {
      return;
    }
    const intervalId = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(intervalId);
  }, [hasActiveMcpActivity]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const updateWidth = (): void => {
      const nextWidth = viewport.clientWidth;
      if (
        lastViewportWidthRef.current > 0 &&
        Math.abs(lastViewportWidthRef.current - nextWidth) >= 0.5
      ) {
        clearCloseFreeze();
      }
      lastViewportWidthRef.current = nextWidth;
      setViewportWidth(nextWidth);
    };
    const observer = new ResizeObserver(updateWidth);
    observer.observe(viewport);
    updateWidth();
    return () => observer.disconnect();
  }, [clearCloseFreeze]);

  useEffect(() => {
    const previousTabIds = previousTabIdsRef.current;
    if (frozenWidths && !equalTabIdOrder(previousTabIds, tabIds)) {
      const pendingClosedTabId = pendingClosedTabIdRef.current;
      const expectedTabIds = pendingClosedTabId
        ? previousTabIds.filter((tabId) => tabId !== pendingClosedTabId)
        : previousTabIds;
      if (pendingClosedTabId && equalTabIdOrder(expectedTabIds, tabIds)) {
        pendingClosedTabIdRef.current = null;
      } else {
        clearCloseFreeze();
      }
    }
    previousTabIdsRef.current = tabIds;
  }, [clearCloseFreeze, frozenWidths, tabIds, tabIdsKey]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const activeSlot = slotRefs.current.get(activeTabId);
      if (!viewport || !activeSlot) {
        return;
      }
      const viewportRect = viewport.getBoundingClientRect();
      const tabRect = activeSlot.getBoundingClientRect();
      const tabLeft = tabRect.left - viewportRect.left + viewport.scrollLeft;
      const tabRight = tabLeft + tabRect.width;
      let nextScrollLeft: number | null = null;
      if (tabLeft < viewport.scrollLeft) {
        nextScrollLeft = tabLeft;
      } else if (tabRight > viewport.scrollLeft + viewport.clientWidth) {
        nextScrollLeft = tabRight - viewport.clientWidth;
      }
      if (nextScrollLeft !== null) {
        viewport.scrollTo({
          left: Math.max(0, nextScrollLeft),
          behavior: nextScrollBehaviorRef.current,
        });
      }
      nextScrollBehaviorRef.current = "auto";
      const pendingFocusTabId = pendingFocusTabIdRef.current;
      if (pendingFocusTabId === activeTabId) {
        tabButtonRefs.current.get(activeTabId)?.focus({ preventScroll: true });
        pendingFocusTabIdRef.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeTabId, frozenWidths, tabIdsKey, viewportWidth, widthByTabId]);

  useEffect(
    () => () => {
      if (closeFreezeTimerRef.current !== null) {
        window.clearTimeout(closeFreezeTimerRef.current);
      }
    },
    [],
  );

  const selectTab = useMemoizedFn(
    (
      tabId: string,
      options: { clearFreeze?: boolean; focus?: boolean } = {},
    ) => {
      if (options.clearFreeze) {
        clearCloseFreeze();
      }
      nextScrollBehaviorRef.current = "smooth";
      if (options.focus) {
        pendingFocusTabIdRef.current = tabId;
      }
      onSelectTab(tabId);
    },
  );

  const beginClose = useMemoizedFn(
    (event: ReactPointerEvent<HTMLButtonElement>, tabId: string) => {
      const measuredWidths = Object.fromEntries(
        tabs.flatMap((tab) => {
          const slot = slotRefs.current.get(tab.id);
          return slot ? [[tab.id, slot.getBoundingClientRect().width]] : [];
        }),
      );
      pendingClosedTabIdRef.current = tabId;
      closePointerTypeRef.current = event.pointerType || "mouse";
      setFrozenWidths(measuredWidths);
      if (closeFreezeTimerRef.current !== null) {
        window.clearTimeout(closeFreezeTimerRef.current);
        closeFreezeTimerRef.current = null;
      }
      if (closePointerTypeRef.current !== "mouse") {
        closeFreezeTimerRef.current = window.setTimeout(
          clearCloseFreeze,
          1800,
        );
      }
      onCloseTab(event, tabId);
    },
  );

  const handleKeyDown = useMemoizedFn(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      const currentIndex = tabs.findIndex((tab) => tab.id === tabId);
      if (currentIndex < 0 || tabs.length === 0) {
        return;
      }
      let nextIndex: number | null = null;
      if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      }
      if (nextIndex === null) {
        return;
      }
      event.preventDefault();
      selectTab(tabs[nextIndex]!.id, { focus: true });
    },
  );

  const renderTab = (
    tab: TerminalBrowserTabState,
    sortProps: SortableTabRenderProps,
  ) => {
    const selected = tab.id === activeTabId;
    const tabLabel = browserTabLabel(tab.title, tab.url);
    const width = widthByTabId[tab.id] ?? TERMINAL_BROWSER_TAB_PREFERRED_WIDTH;
    const density = getTerminalBrowserTabDensity(width);
    const mcpOperating =
      typeof tab.mcpActivityUntil === "number" && tab.mcpActivityUntil > now;
    const showTitle = density !== "icon-only" || selected;
    const showClose = selected || density !== "icon-only";
    return (
      <div
        ref={(element) => {
          if (sortProps.isDragging) {
            return;
          }
          if (element) {
            slotRefs.current.set(tab.id, element);
          } else {
            slotRefs.current.delete(tab.id);
          }
        }}
        className={[
          "group flex h-7 shrink-0 items-center gap-1 overflow-hidden rounded-md border px-2 text-xs transition-colors",
          sortProps.isDragging
            ? "border-sky-500/60 bg-sky-500/20 text-slate-50 opacity-90 shadow-lg"
            : mcpOperating
              ? "border-emerald-400/80 bg-emerald-500/15 text-slate-50 shadow-[0_0_0_1px_rgba(52,211,153,0.28)]"
              : selected
                ? "border-sky-500/60 bg-sky-500/15 text-slate-50"
                : "border-slate-800 bg-slate-900/60 text-slate-300 hover:bg-slate-900",
        ].join(" ")}
        style={{ width, minWidth: width, maxWidth: width }}
        data-terminal-browser-tab-slot={tab.id}
        data-density={density}
        data-width={width}
      >
        <button
          ref={(element) => {
            if (sortProps.isDragging) {
              return;
            }
            if (element) {
              tabButtonRefs.current.set(tab.id, element);
            } else {
              tabButtonRefs.current.delete(tab.id);
            }
          }}
          type="button"
          role="tab"
          aria-selected={selected}
          aria-label={tabLabel}
          title={tabLabel}
          tabIndex={selected ? 0 : -1}
          className="flex min-w-0 flex-1 items-center gap-1 outline-none"
          onClick={() => selectTab(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, tab.id)}
        >
          <BrowserGroupMarker browserGroupId={tab.browserGroupId} />
          {tab.loading ? (
            <LoaderCircle
              className="h-3.5 w-3.5 shrink-0 animate-spin"
              aria-label="Loading"
            />
          ) : (
            <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          {showTitle ? <span className="truncate">{tabLabel}</span> : null}
          {mcpOperating && density === "comfortable" ? (
            <span
              className="ml-1 inline-flex h-4 shrink-0 items-center gap-1 rounded bg-emerald-400/20 px-1 text-[9px] font-semibold leading-none text-emerald-100"
              title="MCP is controlling this tab"
              data-mcp-indicator="badge"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
              MCP
            </span>
          ) : null}
          {mcpOperating && density === "compact" ? (
            <span
              className="ml-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-300"
              title="MCP is controlling this tab"
              data-mcp-indicator="dot"
            />
          ) : null}
        </button>
        {showClose ? (
          <button
            type="button"
            aria-label={`Close ${tabLabel}`}
            title={`Close ${tabLabel}`}
            className={[
              "ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-slate-500 outline-none hover:bg-slate-700 hover:text-slate-100 focus-visible:bg-slate-700 focus-visible:text-slate-100",
              selected
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            ].join(" ")}
            onPointerDown={(event) => beginClose(event, tab.id)}
            onClick={(event) => {
              if (event.detail === 0) {
                clearCloseFreeze();
                onCloseTab(event, tab.id);
              }
            }}
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-slate-800 px-2"
      data-terminal-browser-tab-bar
      data-close-frozen={frozenWidths ? "true" : "false"}
      onPointerLeave={() => {
        if (closePointerTypeRef.current === "mouse") {
          clearCloseFreeze();
        }
      }}
    >
      <div
        ref={viewportRef}
        className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Browser tabs"
        data-terminal-browser-tab-viewport
      >
        {onReorder ? (
          <SortableTabs
            items={tabs}
            getItemId={(tab) => tab.id}
            onReorder={(fromIndex, toIndex) => {
              clearCloseFreeze();
              onReorder(fromIndex, toIndex);
            }}
            className="flex w-max items-center gap-1 [&>div]:shrink-0"
            renderTab={renderTab}
          />
        ) : (
          <div className="flex w-max items-center gap-1">
            {tabs.map((tab) => (
              <div key={tab.id}>{renderTab(tab, { isDragging: false })}</div>
            ))}
          </div>
        )}
      </div>
      <TerminalBrowserTabOverview
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={(tabId) => selectTab(tabId, { clearFreeze: true })}
        onCloseTab={(event, tabId) => {
          clearCloseFreeze();
          onCloseTab(event, tabId);
        }}
      />
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        aria-label="New browser tab"
        title="New browser tab"
        onClick={() => {
          clearCloseFreeze();
          onCreateTab();
        }}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
