import { Globe2, Plus, X } from "lucide-react";
import {
  useEffect,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TerminalBrowserTabState } from "../../features/terminal/preview-store";
import { Button } from "../ui/button";
import {
  SortableTabs,
  type SortableTabRenderProps,
} from "../ui/sortable-tabs";

interface TerminalBrowserTabsProps {
  tabs: TerminalBrowserTabState[];
  activeTabId: string;
  onCreateTab: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (event: ReactPointerEvent, tabId: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

const BROWSER_GROUP_COLORS = [
  "#38bdf8",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#a78bfa",
  "#2dd4bf",
  "#fb7185",
  "#84cc16",
  "#60a5fa",
  "#f87171",
  "#22c55e",
  "#e879f9",
  "#06b6d4",
  "#f97316",
  "#c084fc",
  "#14b8a6",
  "#eab308",
  "#ec4899",
  "#10b981",
  "#818cf8",
  "#ef4444",
  "#65a30d",
  "#d946ef",
  "#0ea5e9",
];

export function browserTabLabel(title: string, url: string): string {
  const normalizedUrl = url === "about:blank" ? "" : url;
  return title.trim() || normalizedUrl.replace(/^https?:\/\//, "") || "New Tab";
}

function getBrowserGroupColor(browserGroupId?: string): string {
  if (!browserGroupId) {
    return "#64748b";
  }
  let hash = 0;
  for (let index = 0; index < browserGroupId.length; index += 1) {
    hash = (hash * 31 + browserGroupId.charCodeAt(index)) >>> 0;
  }
  return BROWSER_GROUP_COLORS[hash % BROWSER_GROUP_COLORS.length]!;
}

function getBrowserGroupLabel(browserGroupId?: string): string {
  if (!browserGroupId) {
    return "Group pending";
  }
  return `Group ${browserGroupId.slice(-6)}`;
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

export function TerminalBrowserTabs({
  tabs,
  activeTabId,
  onCreateTab,
  onSelectTab,
  onCloseTab,
  onReorder,
}: TerminalBrowserTabsProps) {
  const [now, setNow] = useState(() => Date.now());
  const hasActiveMcpActivity = tabs.some(
    (tab) => typeof tab.mcpActivityUntil === "number" && tab.mcpActivityUntil > now,
  );

  useEffect(() => {
    if (!hasActiveMcpActivity) {
      return;
    }
    const intervalId = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(intervalId);
  }, [hasActiveMcpActivity]);

  return (
    <div
      className="flex h-9 min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="Browser tabs"
    >
      {onReorder ? (
        <SortableTabs
          items={tabs}
          getItemId={(tab) => tab.id}
          onReorder={onReorder}
          className="flex min-w-0 flex-1 items-center gap-1"
          renderTab={(tab: TerminalBrowserTabState, sortProps: SortableTabRenderProps) => {
            const selected = tab.id === activeTabId;
            const tabLabel = browserTabLabel(tab.title, tab.url);
            const mcpOperating =
              typeof tab.mcpActivityUntil === "number" &&
              tab.mcpActivityUntil > now;
            return (
              <div
                className={[
                  "group flex h-7 min-w-[76px] max-w-[220px] flex-1 basis-0 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
                  sortProps.isDragging
                    ? "border-sky-500/60 bg-sky-500/20 text-slate-50 opacity-90 shadow-lg scale-[1.02]"
                    : mcpOperating
                      ? "border-emerald-400/80 bg-emerald-500/15 text-slate-50 shadow-[0_0_0_1px_rgba(52,211,153,0.28)]"
                    : selected
                      ? "border-sky-500/60 bg-sky-500/15 text-slate-50"
                      : "border-slate-800 bg-slate-900/60 text-slate-300 hover:bg-slate-900",
                ].join(" ")}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={tabLabel}
                  title={tabLabel}
                  className="flex min-w-0 flex-1 items-center gap-1"
                  onClick={() => onSelectTab(tab.id)}
                >
                  <BrowserGroupMarker browserGroupId={tab.browserGroupId} />
                  <Globe2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{tabLabel}</span>
                  {mcpOperating ? (
                    <span
                      className="ml-1 inline-flex h-4 shrink-0 items-center gap-1 rounded bg-emerald-400/20 px-1 text-[9px] font-semibold leading-none text-emerald-100"
                      title="MCP is controlling this tab"
                    >
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
                      MCP
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label="Close browser tab"
                  className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-700 hover:text-slate-100"
                  onPointerDown={(event) => onCloseTab(event, tab.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          }}
        />
      ) : (
        tabs.map((tab) => {
          const selected = tab.id === activeTabId;
          const tabLabel = browserTabLabel(tab.title, tab.url);
          const mcpOperating =
            typeof tab.mcpActivityUntil === "number" &&
            tab.mcpActivityUntil > now;
          return (
            <div
              key={tab.id}
              className={[
                "group flex h-7 min-w-[76px] max-w-[220px] flex-1 basis-0 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
                mcpOperating
                  ? "border-emerald-400/80 bg-emerald-500/15 text-slate-50 shadow-[0_0_0_1px_rgba(52,211,153,0.28)]"
                  : selected
                  ? "border-sky-500/60 bg-sky-500/15 text-slate-50"
                  : "border-slate-800 bg-slate-900/60 text-slate-300 hover:bg-slate-900",
              ].join(" ")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={tabLabel}
                title={tabLabel}
                className="flex min-w-0 flex-1 items-center gap-1"
                onClick={() => onSelectTab(tab.id)}
              >
                <BrowserGroupMarker browserGroupId={tab.browserGroupId} />
                <Globe2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{tabLabel}</span>
                {mcpOperating ? (
                  <span
                    className="ml-1 inline-flex h-4 shrink-0 items-center gap-1 rounded bg-emerald-400/20 px-1 text-[9px] font-semibold leading-none text-emerald-100"
                    title="MCP is controlling this tab"
                  >
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
                    MCP
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                aria-label="Close browser tab"
                className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-700 hover:text-slate-100"
                onPointerDown={(event) => onCloseTab(event, tab.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 shrink-0 rounded-md px-0"
        aria-label="New browser tab"
        title="New browser tab"
        onClick={onCreateTab}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
