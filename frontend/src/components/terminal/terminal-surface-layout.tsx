import {
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalPanelWorkspace } from "@runweave/shared";
import { ArrowDown, ArrowUp, PencilLine, X } from "lucide-react";
import { TerminalMobileKeybar } from "./terminal-mobile-keybar";
import { TerminalPaneResizeOverlay } from "./terminal-pane-resize-overlay";
import { TerminalSearchToolbar } from "./terminal-search-toolbar";
import type {
  PastedImageReference,
  SearchDirection,
  TerminalSearchOptions,
  TerminalSearchResults,
} from "./terminal-surface-utils";

const FLOATING_COMPOSER_TEXTAREA_MAX_HEIGHT = 96;

interface TerminalSurfaceLayoutProps {
  active: boolean;
  clientMode: "desktop" | "mobile";
  error: string | null;
  mobileKeybarOpen: boolean;
  pasteError: string | null;
  pastedImages: PastedImageReference[];
  paneWorkspace: TerminalPanelWorkspace | null;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchOpen: boolean;
  searchOptions: TerminalSearchOptions;
  searchQuery: string;
  searchResults: TerminalSearchResults | null;
  floatingComposerDraft: string;
  floatingComposerDiagnostics: {
    activeCommand: string | null;
    bottomOffsetRows: number;
    bufferType: "normal" | "alternate" | undefined;
    draftMirrorSupported: boolean;
    floatingComposerEligible: boolean;
    sessionStatus: string | null;
    terminalAgent: string | null;
    terminalAtBottom: boolean;
    terminalState: string | null;
    tmuxScrollbackActive: boolean;
  };
  showFloatingComposerTrigger: boolean;
  floatingComposerVisible: boolean;
  hasNewOutputBelow: boolean;
  showFloatingComposerScrollButton: boolean;
  showMobileKeybarToggle: boolean;
  showScrollToBottomButton: boolean;
  showTerminalToolbar: boolean;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  onRunSearch: (direction: SearchDirection, query?: string) => void;
  onResizePane?: (
    panelId: string,
    direction: "left" | "right" | "up" | "down",
    cells: number,
  ) => void;
  onSearchOpenChange: Dispatch<SetStateAction<boolean>>;
  onSearchOptionsChange: Dispatch<SetStateAction<TerminalSearchOptions>>;
  onSearchQueryChange: Dispatch<SetStateAction<string>>;
  onFloatingComposerDraftChange: (value: string) => void;
  onFloatingComposerClose: () => void;
  onFloatingComposerOpen: () => void;
  onFloatingComposerScrollToBottom: () => void;
  onFloatingComposerSend: () => void;
  onSendInput: (data: string) => void;
  onMobileKeybarOpenChange: Dispatch<SetStateAction<boolean>>;
  onScrollToBottom: () => void;
}

export function TerminalSurfaceLayout({
  active,
  clientMode,
  error,
  mobileKeybarOpen,
  pasteError,
  pastedImages,
  paneWorkspace,
  searchInputRef,
  searchOpen,
  searchOptions,
  searchQuery,
  searchResults,
  floatingComposerDraft,
  floatingComposerDiagnostics,
  showFloatingComposerTrigger,
  floatingComposerVisible,
  hasNewOutputBelow,
  showFloatingComposerScrollButton,
  showMobileKeybarToggle,
  showScrollToBottomButton,
  showTerminalToolbar,
  terminalContainerRef,
  terminalRef,
  onRunSearch,
  onResizePane,
  onSearchOpenChange,
  onSearchOptionsChange,
  onSearchQueryChange,
  onFloatingComposerDraftChange,
  onFloatingComposerClose,
  onFloatingComposerOpen,
  onFloatingComposerScrollToBottom,
  onFloatingComposerSend,
  onSendInput,
  onMobileKeybarOpenChange,
  onScrollToBottom,
}: TerminalSurfaceLayoutProps) {
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeComposerTextarea = (textarea: HTMLTextAreaElement | null) => {
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    const nextHeight = Math.min(
      textarea.scrollHeight,
      FLOATING_COMPOSER_TEXTAREA_MAX_HEIGHT,
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > FLOATING_COMPOSER_TEXTAREA_MAX_HEIGHT
        ? "auto"
        : "hidden";
  };

  useLayoutEffect(() => {
    resizeComposerTextarea(composerTextareaRef.current);
  }, [floatingComposerDraft, floatingComposerVisible]);

  useEffect(() => {
    if (!floatingComposerVisible) {
      return;
    }

    composerTextareaRef.current?.focus();
  }, [floatingComposerVisible]);

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onFloatingComposerSend();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      terminalRef.current?.focus();
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-floating-composer-active-command={
        floatingComposerDiagnostics.activeCommand ?? ""
      }
      data-floating-composer-at-bottom={String(
        floatingComposerDiagnostics.terminalAtBottom,
      )}
      data-floating-composer-bottom-offset-rows={
        floatingComposerDiagnostics.bottomOffsetRows
      }
      data-floating-composer-buffer-type={
        floatingComposerDiagnostics.bufferType ?? ""
      }
      data-floating-composer-draft-mirror-supported={String(
        floatingComposerDiagnostics.draftMirrorSupported,
      )}
      data-floating-composer-eligible={String(
        floatingComposerDiagnostics.floatingComposerEligible,
      )}
      data-floating-composer-scroll-button-mode={
        showFloatingComposerScrollButton
          ? "floating"
          : showScrollToBottomButton
            ? "legacy"
            : "none"
      }
      data-floating-composer-session-status={
        floatingComposerDiagnostics.sessionStatus ?? ""
      }
      data-floating-composer-terminal-agent={
        floatingComposerDiagnostics.terminalAgent ?? ""
      }
      data-floating-composer-terminal-state={
        floatingComposerDiagnostics.terminalState ?? ""
      }
      data-floating-composer-tmux-scrollback-active={String(
        floatingComposerDiagnostics.tmuxScrollbackActive,
      )}
      data-floating-composer-visible={String(floatingComposerVisible)}
      data-floating-composer-trigger-visible={String(showFloatingComposerTrigger)}
      data-testid="terminal-floating-composer-diagnostics"
    >
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
        {onResizePane ? (
          <TerminalPaneResizeOverlay
            workspace={paneWorkspace}
            terminalRef={terminalRef}
            onResize={onResizePane}
          />
        ) : null}
        {floatingComposerVisible ? (
          <div className="pointer-events-none absolute right-2 bottom-3.5 left-2 z-40 flex flex-col items-center gap-1">
            {showFloatingComposerScrollButton ? (
              <button
                type="button"
                aria-label="Scroll terminal to bottom"
                title="Scroll to bottom"
                className="pointer-events-auto grid h-9 w-9 place-items-center rounded-full border border-slate-600 bg-slate-950/95 text-slate-100 shadow-lg shadow-slate-950/40 backdrop-blur transition hover:border-slate-500 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:bg-slate-800"
                onPointerDown={(event) => {
                  event.preventDefault();
                }}
                onClick={onFloatingComposerScrollToBottom}
              >
                <ArrowDown aria-hidden="true" className="h-4 w-4" />
              </button>
            ) : null}
            <section
              aria-label="Floating terminal composer"
              className="pointer-events-auto grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-2 rounded-lg border border-slate-700/90 bg-[#07111f]/95 px-2.5 py-2 shadow-2xl shadow-slate-950/45 backdrop-blur transition focus-within:border-cyan-400/45 focus-within:shadow-[0_18px_50px_rgba(2,6,23,0.52),0_0_0_1px_rgba(34,211,238,0.12)]"
            >
              <button
                type="button"
                aria-label="Close floating composer"
                title="Close composer"
                className="grid h-7 w-7 place-items-center rounded-full border border-slate-700 bg-slate-900/70 text-slate-400 transition hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-300 active:bg-slate-800"
                onPointerDown={(event) => {
                  event.preventDefault();
                }}
                onClick={onFloatingComposerClose}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
              <textarea
                ref={composerTextareaRef}
                aria-label="Terminal input"
                className="min-h-7 max-h-24 w-full resize-none border-0 bg-transparent px-0 py-[5px] font-mono text-xs leading-[18px] text-slate-200 outline-none placeholder:text-slate-500"
                rows={1}
                spellCheck={false}
                value={floatingComposerDraft}
                onChange={(event) => {
                  resizeComposerTextarea(event.currentTarget);
                  onFloatingComposerDraftChange(event.currentTarget.value);
                }}
                onKeyDown={handleComposerKeyDown}
              />
              <button
                type="button"
                aria-label="Send"
                title="Send"
                className="grid h-7 w-7 place-items-center rounded-full border border-cyan-400/40 bg-cyan-400/18 text-cyan-50 transition hover:border-cyan-300/60 hover:bg-cyan-400/28 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 active:bg-cyan-400/35 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800/70 disabled:text-slate-500"
                disabled={floatingComposerDraft.length === 0}
                onPointerDown={(event) => {
                  event.preventDefault();
                }}
                onClick={onFloatingComposerSend}
              >
                <ArrowUp aria-hidden="true" className="h-4 w-4" />
              </button>
            </section>
          </div>
        ) : null}
        {showScrollToBottomButton || showFloatingComposerTrigger ? (
          <div className="pointer-events-none absolute right-4 bottom-4 z-30 flex flex-col items-center gap-2">
            {showFloatingComposerTrigger ? (
              <button
                type="button"
                aria-label="Open floating composer"
                title="Open composer"
                className="pointer-events-auto grid h-9 w-9 place-items-center rounded-full border border-slate-600 bg-slate-950/95 text-slate-100 shadow-lg shadow-slate-950/40 backdrop-blur transition hover:border-cyan-400/45 hover:bg-slate-900 hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 active:bg-slate-800"
                onPointerDown={(event) => {
                  event.preventDefault();
                }}
                onClick={onFloatingComposerOpen}
              >
                <PencilLine aria-hidden="true" className="h-4 w-4" />
              </button>
            ) : null}
            {showScrollToBottomButton ? (
              <button
                type="button"
                aria-label="Scroll terminal to bottom"
                title="Scroll to bottom"
                className={[
                  "pointer-events-auto grid h-9 w-9 place-items-center rounded-full border border-slate-600 bg-slate-950/95 text-slate-100 shadow-lg shadow-slate-950/40 backdrop-blur transition hover:border-slate-500 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:bg-slate-800",
                  hasNewOutputBelow ? "ring-1 ring-sky-400/70" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onPointerDown={(event) => {
                  event.preventDefault();
                }}
                onClick={onScrollToBottom}
              >
                <ArrowDown aria-hidden="true" className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        ) : null}
        <TerminalMobileKeybar
          visible={active && clientMode === "mobile" && mobileKeybarOpen}
          onSendInput={onSendInput}
        />
      </div>
    </div>
  );
}
