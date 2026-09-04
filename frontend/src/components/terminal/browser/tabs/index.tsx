import { useMemoizedFn } from "ahooks";
import { File, LoaderCircle, Plus, X } from "lucide-react";
import type { TerminalBrowserGroupSnapshot } from "@runweave/shared/terminal-browser-workspace";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TerminalBrowserTabState } from "../../../../features/terminal/preview/store";
import {
  SortableTabs,
  type SortableTabRenderProps,
} from "../../../ui/sortable-tabs";
import { TerminalBrowserTabOverview } from "./overview";
import {
  TERMINAL_BROWSER_ACTIVE_TAB_MIN_WIDTH,
  TERMINAL_BROWSER_INACTIVE_TAB_MIN_WIDTH,
  TERMINAL_BROWSER_TAB_PREFERRED_WIDTH,
  browserTabLabel,
  calculateTerminalBrowserTabWidths,
  getBrowserGroupColor,
  getTerminalBrowserFaviconFallback,
  getTerminalBrowserTabDensity,
} from "./utils";

interface TerminalBrowserTabsProps {
  tabs: TerminalBrowserTabState[];
  groups: TerminalBrowserGroupSnapshot[];
  activeTabId: string;
  onCreateTab: () => void;
  onCreateGroup: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (
    event: { stopPropagation: () => void },
    tabId: string,
  ) => void;
  onReorder?: (groupId: string, fromIndex: number, toIndex: number) => void;
  onRenameGroup: (groupId: string, name: string) => Promise<void>;
  onCloseGroup: (groupId: string) => Promise<void>;
}

function equalTabIdOrder(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((tabId, index) => tabId === right[index])
  );
}

export function TerminalBrowserTabs({
  tabs,
  groups,
  activeTabId,
  onCreateTab,
  onCreateGroup,
  onSelectTab,
  onCloseTab,
  onReorder,
  onRenameGroup,
  onCloseGroup,
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
  const tabsById = useMemo(
    () => new Map(tabs.map((tab) => [tab.id, tab])),
    [tabs],
  );
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
    const faviconFallback = getTerminalBrowserFaviconFallback(tab.url);
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
            : selected
                ? "border-sky-500/60 bg-sky-500/15 text-slate-50"
                : "border-slate-800 bg-slate-900/60 text-slate-300 hover:bg-slate-900",
        ].join(" ")}
        style={{ width, minWidth: width, maxWidth: width }}
        data-terminal-browser-tab-slot={tab.id}
        data-density={density}
        data-width={width}
        data-navigation-error={tab.navigationError ? "true" : "false"}
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
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
            {tab.loading ? (
              <LoaderCircle
                className="h-3.5 w-3.5 animate-spin"
                aria-label="Loading"
              />
            ) : tab.faviconDataUrl ? (
              <img
                src={tab.faviconDataUrl}
                className="h-3.5 w-3.5 rounded-sm"
                alt=""
                aria-hidden="true"
              />
            ) : faviconFallback ? (
              <span
                className="text-[10px] font-semibold text-slate-300"
                aria-hidden="true"
              >
                {faviconFallback}
              </span>
            ) : (
              <File className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {mcpOperating ? (
              <span
                className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300 ring-1 ring-slate-950"
                title="Agent is operating this tab"
                data-mcp-indicator="dot"
              />
            ) : null}
            {tab.navigationError ? (
              <span
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-400 ring-1 ring-slate-950"
                title={tab.navigationError}
                data-navigation-error-indicator
              />
            ) : null}
          </span>
          {showTitle ? <span className="truncate">{tabLabel}</span> : null}
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
        <div className="flex w-max items-center gap-3">
          {groups.map((group) => {
            const groupTabs = group.tabIds.flatMap((tabId) => {
              const tab = tabsById.get(tabId);
              return tab ? [tab] : [];
            });
            if (groupTabs.length === 0) {
              return null;
            }
            const connected = groupTabs.some((tab) => tab.cdpProxyAttached);
            const hasError = groupTabs.some((tab) => tab.navigationError);
            return (
              <div
                key={group.id}
                className="relative flex shrink-0 items-center pt-1"
                data-terminal-browser-group={group.id}
                data-group-connected={connected ? "true" : "false"}
                data-group-error={hasError ? "true" : "false"}
              >
                <span
                  role="img"
                  aria-label={`工作组 ${group.name}`}
                  title={group.name}
                  className="absolute inset-x-0 top-0 h-px rounded-full"
                  style={{ backgroundColor: getBrowserGroupColor(group.id) }}
                  data-terminal-browser-group-line
                >
                  {connected ? (
                    <span
                      className="absolute -top-0.5 left-0 h-1.5 w-1.5 rounded-full bg-emerald-300 ring-1 ring-slate-950"
                      title="Agent/自动化已连接"
                      data-group-connected-indicator
                    />
                  ) : null}
                  {hasError ? (
                    <span
                      className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-400 ring-1 ring-slate-950"
                      title="工作组中有页面导航失败"
                      data-group-error-indicator
                    />
                  ) : null}
                </span>
                {onReorder ? (
                  <SortableTabs
                    items={groupTabs}
                    getItemId={(tab) => tab.id}
                    onReorder={(fromIndex, toIndex) => {
                      clearCloseFreeze();
                      onReorder(group.id, fromIndex, toIndex);
                    }}
                    className="flex w-max items-center gap-1 [&>div]:shrink-0"
                    renderTab={renderTab}
                  />
                ) : (
                  <div className="flex w-max items-center gap-1">
                    {groupTabs.map((tab) => (
                      <div key={tab.id}>
                        {renderTab(tab, { isDragging: false })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <TerminalBrowserTabOverview
        tabs={tabs}
        groups={groups}
        activeTabId={activeTabId}
        onSelectTab={(tabId) => selectTab(tabId, { clearFreeze: true })}
        onCloseTab={(event, tabId) => {
          clearCloseFreeze();
          onCloseTab(event, tabId);
        }}
        onCreateGroup={onCreateGroup}
        onRenameGroup={onRenameGroup}
        onCloseGroup={onCloseGroup}
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
