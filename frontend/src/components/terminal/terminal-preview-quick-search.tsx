import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { Command } from "cmdk";
import { File, FileText, Folder, Search } from "lucide-react";
import type { TerminalPreviewContentSearchItem, TerminalPreviewFileSearchItem, TerminalPreviewFolderSearchItem, TerminalPreviewQuickSearchMode } from "@runweave/shared/terminal/preview";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";

interface QuickSearchResults {
  files: TerminalPreviewFileSearchItem[];
  content: TerminalPreviewContentSearchItem[];
  folders: TerminalPreviewFolderSearchItem[];
}

interface TerminalPreviewQuickSearchProps {
  open: boolean;
  mode: TerminalPreviewQuickSearchMode;
  query: string;
  results: QuickSearchResults;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: TerminalPreviewQuickSearchMode) => void;
  onQueryChange: (query: string) => void;
  onOpenFile: (
    path: string,
    lineTarget?: { line: number; column: number },
  ) => void;
  onRevealDirectory: (path: string) => void;
}

const MODES: Array<{
  mode: TerminalPreviewQuickSearchMode;
  label: string;
  title: string;
  placeholder: string;
}> = [
  {
    mode: "files",
    label: "Files",
    title: "Go to file",
    placeholder: "Search files by name or path...",
  },
  {
    mode: "content",
    label: "Content",
    title: "Search in files",
    placeholder: "Search text in current project...",
  },
  {
    mode: "folders",
    label: "Folders",
    title: "Go to folder",
    placeholder: "Search folders by path...",
  },
];
const DEFAULT_MODE = MODES[0]!;

function getItemsForMode(
  mode: TerminalPreviewQuickSearchMode,
  results: QuickSearchResults,
) {
  if (mode === "files") {
    return results.files;
  }
  if (mode === "content") {
    return results.content;
  }
  return results.folders;
}

function renderHighlightedSnippet(
  item: TerminalPreviewContentSearchItem,
): ReactNode {
  if (item.ranges.length === 0) {
    return item.lineText;
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  item.ranges.forEach((range, index) => {
    if (range.start > cursor) {
      parts.push(
        <Fragment key={`text-${index}`}>
          {item.lineText.slice(cursor, range.start)}
        </Fragment>,
      );
    }
    parts.push(
      <mark
        key={`mark-${index}`}
        className="rounded-sm bg-amber-400/20 px-0.5 text-amber-100"
      >
        {item.lineText.slice(range.start, range.end)}
      </mark>,
    );
    cursor = Math.max(cursor, range.end);
  });
  if (cursor < item.lineText.length) {
    parts.push(
      <Fragment key="tail">{item.lineText.slice(cursor)}</Fragment>,
    );
  }
  return parts;
}

function SearchModeTabs({
  mode,
  onModeChange,
}: {
  mode: TerminalPreviewQuickSearchMode;
  onModeChange: (mode: TerminalPreviewQuickSearchMode) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 px-2.5 pt-2"
      role="tablist"
      aria-label="Search mode"
    >
      {MODES.map((item) => (
        <button
          key={item.mode}
          type="button"
          role="tab"
          className={[
            "h-7 rounded-md px-2.5 text-xs text-slate-400 transition",
            mode === item.mode
              ? "bg-slate-800 text-slate-100"
              : "hover:bg-slate-900 hover:text-slate-200",
          ].join(" ")}
          aria-selected={mode === item.mode}
          aria-pressed={mode === item.mode}
          onClick={() => onModeChange(item.mode)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function FileResultRow({ item }: { item: TerminalPreviewFileSearchItem }) {
  return (
    <>
      <File className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-100">
          {item.basename}
        </span>
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
    </>
  );
}

function ContentResultRow({
  item,
}: {
  item: TerminalPreviewContentSearchItem;
}) {
  return (
    <>
      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-100">
          {item.basename}
        </span>
        {item.dirname ? (
          <span className="block truncate text-xs text-slate-500">
            {item.dirname}
          </span>
        ) : null}
        <span className="mt-1 block truncate text-xs text-slate-300">
          {renderHighlightedSnippet(item)}
        </span>
      </span>
      <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
        {item.line}:{item.column}
      </span>
    </>
  );
}

function FolderResultRow({
  item,
}: {
  item: TerminalPreviewFolderSearchItem;
}) {
  return (
    <>
      <Folder className="h-4 w-4 shrink-0 text-amber-400/80" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-100">
          {item.basename}
        </span>
        {item.dirname ? (
          <span className="block truncate text-xs text-slate-500">
            {item.dirname}
          </span>
        ) : null}
      </span>
      <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
        DIR
      </span>
    </>
  );
}

export function TerminalPreviewQuickSearch({
  open,
  mode,
  query,
  results,
  loading,
  error,
  truncated,
  onOpenChange,
  onModeChange,
  onQueryChange,
  onOpenFile,
  onRevealDirectory,
}: TerminalPreviewQuickSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeMode = MODES.find((item) => item.mode === mode) ?? DEFAULT_MODE;
  const items = getItemsForMode(mode, results);

  useEffect(() => {
    if (!open) {
      return;
    }
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, mode]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="Explorer quick search"
        className="bottom-20 top-20 flex h-auto min-h-0 w-[min(780px,calc(100vw-48px))] max-w-none translate-y-0 grid-rows-none flex-col gap-0 overflow-hidden rounded-[10px] border-slate-700 bg-slate-950 p-0 text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.55)] data-[state=closed]:slide-out-to-top-0 data-[state=open]:slide-in-from-top-0"
      >
        <DialogTitle className="sr-only">Explorer quick search</DialogTitle>
        <DialogDescription className="sr-only">
          Search project files, content, and folders.
        </DialogDescription>
        <Command
          shouldFilter={false}
          className="flex h-full min-h-0 flex-col bg-slate-950"
        >
          <div className="flex min-h-[42px] shrink-0 items-center gap-3 border-b border-slate-800 px-3">
            <strong className="text-[13px] font-semibold text-slate-100">
              {activeMode.title}
            </strong>
          </div>
          <SearchModeTabs mode={mode} onModeChange={onModeChange} />
          <div className="flex shrink-0 items-center gap-2.5 border-b border-slate-800 px-2.5 py-2.5">
            <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 transition focus-within:border-slate-400">
              <Search className="h-4 w-4 shrink-0 text-slate-500" />
              <Command.Input
                ref={inputRef}
                value={query}
                onValueChange={onQueryChange}
                placeholder={activeMode.placeholder}
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
              />
            </div>
          </div>
          <Command.List className="min-h-0 flex-1 overflow-auto p-2">
            {error ? (
              <div className="px-3 py-2 text-sm text-rose-300" role="alert">
                {error}
              </div>
            ) : null}
            <div className="px-2.5 pb-2 pt-1 text-[10px] uppercase tracking-[0.18em] text-slate-500">
              {loading
                ? "Searching"
                : query.trim()
                  ? `${activeMode.label} results`
                  : mode === "files"
                    ? "Changed files"
                    : `${activeMode.label} search`}
            </div>
            <Command.Group>
              {mode === "files"
                ? results.files.map((item, index) => (
                    <Command.Item
                      key={item.path}
                      value={`file:${item.path}`}
                      onSelect={() => onOpenFile(item.path)}
                      className={[
                        "flex min-h-[54px] cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-slate-200 outline-none",
                        index === 0
                          ? "bg-slate-900/80"
                          : "aria-selected:bg-slate-800/80",
                      ].join(" ")}
                    >
                      <FileResultRow item={item} />
                    </Command.Item>
                  ))
                : null}
              {mode === "content"
                ? results.content.map((item, index) => (
                    <Command.Item
                      key={`${item.path}:${item.line}:${item.column}`}
                      value={`content:${item.path}:${item.line}:${item.column}`}
                      onSelect={() =>
                        onOpenFile(item.path, {
                          line: item.line,
                          column: item.column,
                        })
                      }
                      className={[
                        "flex min-h-[72px] cursor-default items-start gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-slate-200 outline-none",
                        index === 0
                          ? "bg-slate-900/80"
                          : "aria-selected:bg-slate-800/80",
                      ].join(" ")}
                    >
                      <ContentResultRow item={item} />
                    </Command.Item>
                  ))
                : null}
              {mode === "folders"
                ? results.folders.map((item, index) => (
                    <Command.Item
                      key={item.path}
                      value={`folder:${item.path}`}
                      onSelect={() => onRevealDirectory(item.path)}
                      className={[
                        "flex min-h-[54px] cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-slate-200 outline-none",
                        index === 0
                          ? "bg-slate-900/80"
                          : "aria-selected:bg-slate-800/80",
                      ].join(" ")}
                    >
                      <FolderResultRow item={item} />
                    </Command.Item>
                  ))
                : null}
            </Command.Group>
            {!loading && !error && items.length === 0 ? (
              <Command.Empty className="px-3 py-8 text-sm text-slate-400">
                {query.trim()
                  ? "No results"
                  : mode === "files"
                    ? "No changed files. Type to search files."
                    : "Type to search."}
              </Command.Empty>
            ) : null}
          </Command.List>
          <div className="flex shrink-0 items-center gap-3 border-t border-slate-800 px-3 py-2 text-[11px] text-slate-500">
            <span>Cmd+P Files</span>
            <span>Cmd+Shift+F Content</span>
            <span>Esc Close</span>
            <span>Enter Open</span>
            <span className="ml-auto">{truncated ? "Showing first 50 results" : ""}</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
