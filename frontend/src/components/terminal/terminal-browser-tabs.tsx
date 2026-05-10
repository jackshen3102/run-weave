import { Globe2, Plus, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
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

export function browserTabLabel(title: string, url: string): string {
  return title.trim() || url.replace(/^https?:\/\//, "");
}

export function TerminalBrowserTabs({
  tabs,
  activeTabId,
  onCreateTab,
  onSelectTab,
  onCloseTab,
  onReorder,
}: TerminalBrowserTabsProps) {
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
            return (
              <div
                className={[
                  "group flex h-7 min-w-[76px] max-w-[220px] flex-1 basis-0 items-center gap-1 rounded-md border px-2 text-xs",
                  sortProps.isDragging
                    ? "border-sky-500/60 bg-sky-500/20 text-slate-50 opacity-90 shadow-lg scale-[1.02]"
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
                  <Globe2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{tabLabel}</span>
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
          return (
            <div
              key={tab.id}
              className={[
                "group flex h-7 min-w-[76px] max-w-[220px] flex-1 basis-0 items-center gap-1 rounded-md border px-2 text-xs",
                selected
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
                <Globe2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{tabLabel}</span>
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
