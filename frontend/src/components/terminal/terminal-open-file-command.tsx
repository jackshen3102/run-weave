import { Command } from "cmdk";
import type { TerminalPreviewFileSearchItem } from "@browser-viewer/shared";

interface TerminalOpenFileCommandProps {
  query: string;
  loading: boolean;
  error: string | null;
  items: TerminalPreviewFileSearchItem[];
  absoluteInput: boolean;
  onQueryChange: (query: string) => void;
  onOpenPath: (path: string) => void;
}

export function TerminalOpenFileCommand({
  query,
  loading,
  error,
  items,
  absoluteInput,
  onQueryChange,
  onOpenPath,
}: TerminalOpenFileCommandProps) {
  const highlightedPath = items[0]?.path;

  return (
    <Command
      shouldFilter={false}
      className="flex h-full min-h-0 flex-col bg-slate-950"
      onKeyDown={(event) => {
        if (event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        const pathToOpen = highlightedPath ?? query.trim();
        if (pathToOpen) {
          onOpenPath(pathToOpen);
        }
      }}
    >
      <div className="border-b border-slate-800 px-3 py-3">
        <Command.Input
          value={query}
          onValueChange={onQueryChange}
          placeholder="Search file or paste absolute path..."
          className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none transition focus:border-slate-400"
        />
      </div>
      <Command.List className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {!query.trim() ? (
          <Command.Empty className="px-3 py-8 text-sm text-slate-400">
            {loading
              ? "Loading changed files..."
              : "No changed files. Type to search files or paste an absolute path."}
          </Command.Empty>
        ) : null}
        {absoluteInput ? (
          <Command.Empty className="px-3 py-8 text-sm text-slate-400">
            Press Enter to open this path
          </Command.Empty>
        ) : null}
        {error ? (
          <div className="px-3 py-2 text-sm text-rose-300" role="alert">
            {error}
          </div>
        ) : null}
        {!absoluteInput ? (
          <div className="px-3 pb-2 pt-1 text-[11px] uppercase tracking-[0.22em] text-slate-500">
            {loading
              ? query.trim()
                ? "Searching"
                : "Loading changes"
              : query.trim()
                ? "Search results"
                : "Changed files"}
          </div>
        ) : null}
        <Command.Group>
          {items.map((item, index) => (
            <Command.Item
              key={item.path}
              value={item.path}
              onSelect={() => {
                onOpenPath(item.path);
              }}
              className={[
                "flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none",
                index === 0 ? "bg-slate-800" : "aria-selected:bg-slate-800/80",
              ].join(" ")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.basename}</span>
                {item.dirname ? (
                  <span className="block truncate text-xs text-slate-500">
                    {item.dirname}
                  </span>
                ) : null}
              </span>
              {item.gitStatus ? (
                <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                  {item.gitStatus.slice(0, 1)}
                </span>
              ) : null}
            </Command.Item>
          ))}
        </Command.Group>
        {query.trim() && !absoluteInput && !loading && items.length === 0 ? (
          <Command.Empty className="px-3 py-8 text-sm text-slate-400">
            No results. Press Enter to open the typed path.
          </Command.Empty>
        ) : null}
      </Command.List>
    </Command>
  );
}
