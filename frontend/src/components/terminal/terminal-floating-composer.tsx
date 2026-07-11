import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { ArrowDown, ArrowUp, PencilLine, X } from "lucide-react";

const TEXTAREA_MAX_HEIGHT = 96;

export interface TerminalFloatingComposerDiagnostics {
  activeCommand: string | null;
  bottomOffsetRows: number;
  bufferType: "normal" | "alternate" | undefined;
  draftMirrorSupported: boolean;
  eligible: boolean;
  sessionStatus: string | null;
  terminalAgent: string | null;
  terminalAtBottom: boolean;
  terminalState: string | null;
  tmuxScrollbackActive: boolean;
}

interface TerminalFloatingComposerProps {
  diagnostics: TerminalFloatingComposerDiagnostics;
  draft: string;
  hasNewOutputBelow: boolean;
  scrollButtonMode: "floating" | "legacy" | "none";
  showTrigger: boolean;
  terminalRef: RefObject<Terminal | null>;
  visible: boolean;
  onClose: () => void;
  onDraftChange: (value: string) => void;
  onOpen: () => void;
  onScrollToBottom: () => void;
  onSend: () => void;
}

function resizeTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return;
  }
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
}

export function TerminalFloatingComposer({
  diagnostics,
  draft,
  hasNewOutputBelow,
  scrollButtonMode,
  showTrigger,
  terminalRef,
  visible,
  onClose,
  onDraftChange,
  onOpen,
  onScrollToBottom,
  onSend,
}: TerminalFloatingComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current);
  }, [draft, visible]);

  useEffect(() => {
    if (visible) {
      textareaRef.current?.focus();
    }
  }, [visible]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      terminalRef.current?.focus();
    }
  };

  const diagnosticsAttributes = {
    "data-floating-composer-active-command": diagnostics.activeCommand ?? "",
    "data-floating-composer-at-bottom": String(diagnostics.terminalAtBottom),
    "data-floating-composer-bottom-offset-rows": diagnostics.bottomOffsetRows,
    "data-floating-composer-buffer-type": diagnostics.bufferType ?? "",
    "data-floating-composer-draft-mirror-supported": String(
      diagnostics.draftMirrorSupported,
    ),
    "data-floating-composer-eligible": String(diagnostics.eligible),
    "data-floating-composer-scroll-button-mode": scrollButtonMode,
    "data-floating-composer-session-status": diagnostics.sessionStatus ?? "",
    "data-floating-composer-terminal-agent": diagnostics.terminalAgent ?? "",
    "data-floating-composer-terminal-state": diagnostics.terminalState ?? "",
    "data-floating-composer-tmux-scrollback-active": String(
      diagnostics.tmuxScrollbackActive,
    ),
    "data-floating-composer-trigger-visible": String(showTrigger),
    "data-floating-composer-visible": String(visible),
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-30"
      data-testid="terminal-floating-composer-diagnostics"
      {...diagnosticsAttributes}
    >
      {visible ? (
        <div className="absolute right-2 bottom-3.5 left-2 flex flex-col items-center gap-1">
          {scrollButtonMode === "floating" ? (
            <ScrollButton onClick={onScrollToBottom} />
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
              onPointerDown={(event) => event.preventDefault()}
              onClick={onClose}
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
            <textarea
              ref={textareaRef}
              aria-label="Terminal input"
              className="min-h-7 max-h-24 w-full resize-none border-0 bg-transparent px-0 py-[5px] font-mono text-xs leading-[18px] text-slate-200 outline-none placeholder:text-slate-500"
              rows={1}
              spellCheck={false}
              value={draft}
              onChange={(event) => {
                resizeTextarea(event.currentTarget);
                onDraftChange(event.currentTarget.value);
              }}
              onKeyDown={handleKeyDown}
            />
            <button
              type="button"
              aria-label="Send"
              title="Send"
              className="grid h-7 w-7 place-items-center rounded-full border border-cyan-400/40 bg-cyan-400/18 text-cyan-50 transition hover:border-cyan-300/60 hover:bg-cyan-400/28 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 active:bg-cyan-400/35 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800/70 disabled:text-slate-500"
              disabled={draft.length === 0}
              onPointerDown={(event) => event.preventDefault()}
              onClick={onSend}
            >
              <ArrowUp aria-hidden="true" className="h-4 w-4" />
            </button>
          </section>
        </div>
      ) : null}
      {!visible && (scrollButtonMode === "legacy" || showTrigger) ? (
        <div className="absolute right-4 bottom-4 flex flex-col items-center gap-2">
          {showTrigger ? (
            <button
              type="button"
              aria-label="Open floating composer"
              title="Open composer"
              className="pointer-events-auto grid h-9 w-9 place-items-center rounded-full border border-slate-600 bg-slate-950/95 text-slate-100 shadow-lg shadow-slate-950/40 backdrop-blur transition hover:border-cyan-400/45 hover:bg-slate-900 hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 active:bg-slate-800"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onOpen}
            >
              <PencilLine aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}
          {scrollButtonMode === "legacy" ? (
            <ScrollButton
              highlight={hasNewOutputBelow}
              onClick={onScrollToBottom}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ScrollButton({
  highlight = false,
  onClick,
}: {
  highlight?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Scroll terminal to bottom"
      title="Scroll to bottom"
      className={[
        "pointer-events-auto grid h-9 w-9 place-items-center rounded-full border border-slate-600 bg-slate-950/95 text-slate-100 shadow-lg shadow-slate-950/40 backdrop-blur transition hover:border-slate-500 hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:bg-slate-800",
        highlight ? "ring-1 ring-sky-400/70" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <ArrowDown aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}
