import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  SearchDirection,
  TerminalSearchOptions,
  TerminalSearchResults,
} from "./terminal-surface-utils";

interface TerminalSearchToolbarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  open: boolean;
  query: string;
  results: TerminalSearchResults | null;
  options: TerminalSearchOptions;
  onQueryChange: (query: string) => void;
  onOptionsChange: Dispatch<SetStateAction<TerminalSearchOptions>>;
  onRunSearch: (direction: SearchDirection, query?: string) => void;
  onOpenChange: (open: boolean) => void;
  onCloseFocus: () => void;
}

export function TerminalSearchToolbar({
  inputRef,
  open,
  query,
  results,
  options,
  onQueryChange,
  onOptionsChange,
  onRunSearch,
  onOpenChange,
  onCloseFocus,
}: TerminalSearchToolbarProps) {
  return (
    <div className="pointer-events-none absolute top-3 right-4 z-10 flex items-start gap-2">
      {open ? (
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/95 px-2 py-2 shadow-[0_18px_44px_-30px_rgba(15,23,42,0.9)] backdrop-blur">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onRunSearch(event.shiftKey ? "previous" : "next");
              }
            }}
            className="w-44 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 outline-none placeholder:text-slate-500"
            placeholder="Find in terminal"
          />
          <span className="min-w-16 text-center text-[11px] text-slate-400">
            {results?.resultCount
              ? `${results.resultIndex + 1}/${results.resultCount}`
              : query
                ? "0/0"
                : "--"}
          </span>
          <button
            type="button"
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:border-slate-500"
            onClick={() => {
              onRunSearch("previous");
            }}
          >
            Prev
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:border-slate-500"
            onClick={() => {
              onRunSearch("next");
            }}
          >
            Next
          </button>
          <SearchOptionButton
            active={options.caseSensitive}
            onClick={() => {
              onOptionsChange((current) => ({
                ...current,
                caseSensitive: !current.caseSensitive,
              }));
            }}
          >
            Aa
          </SearchOptionButton>
          <SearchOptionButton
            active={options.wholeWord}
            onClick={() => {
              onOptionsChange((current) => ({
                ...current,
                wholeWord: !current.wholeWord,
              }));
            }}
          >
            Word
          </SearchOptionButton>
          <SearchOptionButton
            active={options.regex}
            onClick={() => {
              onOptionsChange((current) => ({
                ...current,
                regex: !current.regex,
              }));
            }}
          >
            .*
          </SearchOptionButton>
          <button
            type="button"
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-slate-500"
            onClick={() => {
              onOpenChange(false);
              onCloseFocus();
            }}
          >
            Close
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="pointer-events-auto rounded-full border border-slate-700 bg-slate-950/90 px-3 py-1.5 text-[11px] text-slate-300 backdrop-blur hover:border-slate-500"
          onClick={() => {
            onOpenChange(true);
          }}
        >
          Find
        </button>
      )}
    </div>
  );
}

function SearchOptionButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rounded-md border px-2 py-1 text-[11px] ${
        active
          ? "border-slate-100 bg-slate-100 text-slate-950"
          : "border-slate-700 text-slate-300"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
