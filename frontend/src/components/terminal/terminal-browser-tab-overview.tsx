import { Search, X } from "lucide-react";
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { TerminalBrowserTabState } from "../../features/terminal/preview-store";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  browserTabLabel,
  getBrowserGroupColor,
  getBrowserGroupLabel,
} from "./terminal-browser-tab-utils";

interface TerminalBrowserTabOverviewProps {
  tabs: TerminalBrowserTabState[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (event: ReactMouseEvent<HTMLButtonElement>, tabId: string) => void;
}

export function TerminalBrowserTabOverview({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
}: TerminalBrowserTabOverviewProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredTabs = useMemo(
    () =>
      normalizedQuery
        ? tabs.filter((tab) =>
            [
              browserTabLabel(tab.title, tab.url),
              tab.url,
              tab.browserGroupId ?? "",
              getBrowserGroupLabel(tab.browserGroupId),
            ].some((value) =>
              value.toLocaleLowerCase().includes(normalizedQuery),
            ),
          )
        : tabs,
    [normalizedQuery, tabs],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex h-7 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label="Search all browser tabs"
          title="Search all browser tabs"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="absolute right-0.5 top-0.5 min-w-3 rounded-full bg-slate-700 px-0.5 text-center text-[8px] leading-3 text-slate-200">
            {tabs.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search browser tabs"
          placeholder="Search tabs"
          className="h-8 bg-slate-950 text-xs"
        />
        <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
          {filteredTabs.map((tab) => {
            const label = browserTabLabel(tab.title, tab.url);
            const groupLabel = getBrowserGroupLabel(tab.browserGroupId);
            return (
              <div
                key={tab.id}
                className="flex min-w-0 items-center gap-1 rounded-md border border-slate-800 bg-slate-950/80 p-1"
                data-overview-tab-id={tab.id}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-slate-800"
                  aria-current={tab.id === activeTabId ? "page" : undefined}
                  onClick={() => {
                    onSelectTab(tab.id);
                    setOpen(false);
                  }}
                >
                  <span
                    className="h-4 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: getBrowserGroupColor(tab.browserGroupId) }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-slate-100">
                      {label}
                    </span>
                    <span className="block truncate text-[10px] text-slate-500">
                      {tab.url || groupLabel}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-100"
                  aria-label={`Close ${label}`}
                  title={`Close ${label}`}
                  onClick={(event) => onCloseTab(event, tab.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {filteredTabs.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-slate-500">
              No matching tabs
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
