import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";
import { TerminalMobileKeybar } from "./terminal-mobile-keybar";
import { TerminalSearchToolbar } from "./terminal-search-toolbar";
import type {
  PastedImageReference,
  SearchDirection,
  TerminalSearchOptions,
  TerminalSearchResults,
} from "./terminal-surface-utils";

interface TerminalSurfaceLayoutProps {
  active: boolean;
  clientMode: "desktop" | "mobile";
  error: string | null;
  mobileKeybarOpen: boolean;
  pasteError: string | null;
  pastedImages: PastedImageReference[];
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchOpen: boolean;
  searchOptions: TerminalSearchOptions;
  searchQuery: string;
  searchResults: TerminalSearchResults | null;
  showMobileKeybarToggle: boolean;
  showTerminalToolbar: boolean;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  onRunSearch: (direction: SearchDirection, query?: string) => void;
  onSearchOpenChange: Dispatch<SetStateAction<boolean>>;
  onSearchOptionsChange: Dispatch<SetStateAction<TerminalSearchOptions>>;
  onSearchQueryChange: Dispatch<SetStateAction<string>>;
  onSendInput: (data: string) => void;
  onMobileKeybarOpenChange: Dispatch<SetStateAction<boolean>>;
}

export function TerminalSurfaceLayout({
  active,
  clientMode,
  error,
  mobileKeybarOpen,
  pasteError,
  pastedImages,
  searchInputRef,
  searchOpen,
  searchOptions,
  searchQuery,
  searchResults,
  showMobileKeybarToggle,
  showTerminalToolbar,
  terminalContainerRef,
  terminalRef,
  onRunSearch,
  onSearchOpenChange,
  onSearchOptionsChange,
  onSearchQueryChange,
  onSendInput,
  onMobileKeybarOpenChange,
}: TerminalSurfaceLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error || pasteError ? (
        <p className="px-3 py-2 text-xs text-rose-400">{error ?? pasteError}</p>
      ) : null}
      {pastedImages.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {pastedImages.map((image) => (
            <span
              className="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 font-mono text-xs text-slate-200"
              key={image.id}
              title={image.filePath}
            >
              {image.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {showTerminalToolbar ? (
          <TerminalSearchToolbar
            inputRef={searchInputRef}
            open={searchOpen}
            query={searchQuery}
            results={searchResults}
            options={searchOptions}
            onQueryChange={onSearchQueryChange}
            onOptionsChange={onSearchOptionsChange}
            onRunSearch={onRunSearch}
            onOpenChange={onSearchOpenChange}
            onCloseFocus={() => {
              terminalRef.current?.focus();
            }}
          />
        ) : null}
        {showMobileKeybarToggle ? (
          <div className="pointer-events-none absolute top-3 right-4 z-30">
            <button
              type="button"
              aria-expanded={mobileKeybarOpen}
              aria-label="Toggle terminal shortcut keys"
              className="pointer-events-auto rounded-md border border-slate-700 bg-slate-950/90 px-2 py-1 text-[10px] leading-none text-slate-300 backdrop-blur active:bg-slate-800"
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                onMobileKeybarOpenChange((current) => !current);
                requestAnimationFrame(() => {
                  terminalRef.current?.focus();
                });
              }}
            >
              Keys
            </button>
          </div>
        ) : null}
        <div
          aria-label="Terminal emulator"
          className="h-full min-h-full w-full bg-[#0b1220] pl-2 pt-1.5 pb-1.5"
          role="application"
          tabIndex={0}
          onClick={() => {
            if (active) {
              terminalRef.current?.focus();
            }
          }}
          onFocus={() => {
            if (active) {
              terminalRef.current?.focus();
            }
          }}
          ref={terminalContainerRef}
        />
        <TerminalMobileKeybar
          visible={active && clientMode === "mobile" && mobileKeybarOpen}
          onSendInput={onSendInput}
        />
      </div>
    </div>
  );
}
