import { useMemoizedFn } from "ahooks";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TerminalBrowserFindCommand, TerminalBrowserFindState } from "@runweave/shared/desktop-bridge";
import { Button } from "../../ui/button";

export function useTerminalBrowserFind(tabId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<TerminalBrowserFindState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = Boolean(window.electronAPI?.terminalBrowserFind &&
    window.electronAPI?.terminalBrowserGetFindState && window.electronAPI?.onTerminalBrowserFindChanged);

  useEffect(() => {
    if (!tabId || !enabled || !supported) return;
    let cancelled = false;
    let latestRevision = -1;
    setError(null);
    const accept = (next: TerminalBrowserFindState) => {
      if (cancelled || next.tabId !== tabId || next.revision < latestRevision) return;
      latestRevision = next.revision;
      setState(next);
    };
    const unsubscribe = window.electronAPI!.onTerminalBrowserFindChanged!(accept);
    void window.electronAPI!.terminalBrowserGetFindState!(tabId).then(accept).catch((reason: Error) => {
      if (!cancelled) setError(reason.message);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [tabId, enabled, supported]);

  const command = useMemoizedFn(async (request: TerminalBrowserFindCommand) => {
    if (!tabId || !enabled || !supported) return;
    try {
      await window.electronAPI!.terminalBrowserFind!(tabId, request);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  });
  const current = state?.tabId === tabId ? state : null;
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!enabled || !supported || event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      void command({ action: "open" });
    } else if (event.key === "Escape" && current?.open) {
      event.preventDefault();
      event.stopPropagation();
      void command({ action: "close" });
    }
  };
  return { state: current, error, supported, command, onKeyDownCapture };
}

export function TerminalBrowserFindBar({ find }: { find: ReturnType<typeof useTerminalBrowserFind> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = find.state?.open ?? false;
  const focusRevision = find.state?.focusRevision;
  useLayoutEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, focusRevision]);
  if (!open || !find.state) return null;
  const { query, matches, activeMatchOrdinal } = find.state;
  return (
    <div role="search" aria-label="Find in page" className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-1.5 text-xs text-slate-300">
      <Search className="h-3.5 w-3.5 shrink-0" />
      <input
        ref={inputRef}
        aria-label="Find in page"
        placeholder="Find in page"
        className="h-7 min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-900 px-2 text-slate-100 outline-none focus:border-sky-500"
        defaultValue={query}
        onChange={(event) => void find.command({ action: "search", query: event.target.value })}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== "Enter") return;
          event.preventDefault();
          void find.command({ action: event.shiftKey ? "previous" : "next" });
        }}
      />
      <span role="status" aria-live="polite" className="shrink-0 tabular-nums">
        {query ? `${activeMatchOrdinal}/${matches}` : "0/0"}
      </span>
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!query || matches === 0} onClick={() => void find.command({ action: "previous" })}>
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="Next match" title="Next match (Enter)" disabled={!query || matches === 0} onClick={() => void find.command({ action: "next" })}>
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="Close find" title="Close find (Esc)" onClick={() => void find.command({ action: "close" })}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
