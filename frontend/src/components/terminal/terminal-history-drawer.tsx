import { useEffect, useMemo, useRef, useState } from "react";
import {
  countTerminalLines,
  syncTerminalHistorySize,
  writeTerminalHistoryOutput,
} from "@runweave/common/terminal";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@runweave/shared";
import type { TerminalSessionHistoryResponse } from "@runweave/shared";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { Copy } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import { DEFAULT_TERMINAL_PREFERENCES } from "../../features/terminal/preferences";
import { HttpError } from "../../services/http";
import {
  getTerminalHistory,
  getTerminalPanelHistory,
} from "../../services/terminal";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";

interface TerminalHistoryDrawerProps {
  open: boolean;
  apiBase: string;
  token: string;
  terminalSessionId: string | null;
  terminalPanelId?: string | null;
  terminalProjectId?: string | null;
  terminalThreadId?: string | null;
  terminalPanelThreadId?: string | null;
  terminalName?: string;
  onOpenChange: (open: boolean) => void;
  onAuthExpired?: () => void;
}

export function TerminalHistoryDrawer({
  open,
  apiBase,
  token,
  terminalSessionId,
  terminalPanelId,
  terminalProjectId,
  terminalThreadId,
  terminalPanelThreadId,
  terminalName,
  onOpenChange,
  onAuthExpired,
}: TerminalHistoryDrawerProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const [history, setHistory] = useState<TerminalSessionHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !terminalSessionId) {
      return;
    }

    let cancelled = false;
    setHistory(null);
    setLoading(true);
    setRequestError(null);

    const request = terminalPanelId
      ? getTerminalPanelHistory(apiBase, token, terminalSessionId, terminalPanelId)
      : getTerminalHistory(apiBase, token, terminalSessionId);

    void request
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setHistory(payload);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setHistory(null);
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
          return;
        }
        setRequestError(String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, onAuthExpired, open, terminalPanelId, terminalSessionId, token]);

  const renderedTitle =
    terminalName ??
    (history
      ? formatTerminalSessionName({
          alias: history.alias,
          cwd: history.cwd,
          activeCommand: history.activeCommand,
        })
      : "Terminal History");
  const renderedStatus = useMemo(() => {
    if (!history) {
      return terminalSessionId ? terminalSessionId : "No terminal selected";
    }

    const statusLabel =
      history.status === "exited"
        ? history.exitCode == null
          ? "Exited"
          : `Exited (${history.exitCode})`
        : "Running";
    return `${statusLabel}  ${history.cwd}`;
  }, [history, terminalSessionId]);
  const idRows = useMemo(
    () => [
      {
        label: "Project ID",
        value: history?.projectId ?? terminalProjectId ?? null,
      },
      {
        label: "Terminal ID",
        value: history?.terminalSessionId ?? terminalSessionId,
      },
      {
        label: "Thread ID",
        value: history?.threadId ?? terminalThreadId ?? null,
      },
      {
        label: "Panel ID",
        value: terminalPanelId ?? null,
      },
      {
        label: "Panel Thread",
        value: terminalPanelThreadId ?? null,
      },
    ],
    [
      history?.projectId,
      history?.terminalSessionId,
      history?.threadId,
      terminalPanelId,
      terminalPanelThreadId,
      terminalProjectId,
      terminalSessionId,
      terminalThreadId,
    ],
  );

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!open || !container) {
      return;
    }

    const preferences = DEFAULT_TERMINAL_PREFERENCES;
    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    let canvasAddon: CanvasAddon | null = null;
    const terminal = new Terminal({
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: preferences.fontFamily,
      fontSize: preferences.fontSize,
      lineHeight: 1.2,
      screenReaderMode: preferences.screenReaderMode,
      scrollback: Math.max(
        TERMINAL_CLIENT_SCROLLBACK_LINES,
        countTerminalLines(history?.scrollback ?? "") + 16,
      ),
      theme: {
        background: "#0b1220",
        foreground: "#e2e8f0",
        cursor: "#f8fafc",
        selectionBackground: "rgba(148, 163, 184, 0.28)",
      },
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11Addon);
    try {
      canvasAddon = new CanvasAddon();
      terminal.loadAddon(canvasAddon);
    } catch {
      // xterm falls back to its default DOM renderer if canvas is unavailable.
      canvasAddon = null;
    }
    terminal.open(container);
    terminal.unicode.activeVersion = "11";

    const syncSize = () => {
      syncTerminalHistorySize({
        terminal,
        fitAddon,
        sourceCols: history?.scrollbackSourceCols,
      });
    };

    writeTerminalHistoryOutput({
      terminal,
      output: history?.scrollback ?? "",
      syncSize,
    });

    let mountFitFrameId: number | null = requestAnimationFrame(() => {
      mountFitFrameId = null;
      syncSize();
    });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        syncSize();
      });
      resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", syncSize);
    }

    const refreshTerminalViewport = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      syncSize();
    };
    document.addEventListener("visibilitychange", refreshTerminalViewport);
    window.addEventListener("focus", refreshTerminalViewport);

    return () => {
      if (mountFitFrameId !== null) {
        cancelAnimationFrame(mountFitFrameId);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", syncSize);
      }
      document.removeEventListener("visibilitychange", refreshTerminalViewport);
      window.removeEventListener("focus", refreshTerminalViewport);
      canvasAddon?.dispose();
      terminal.dispose();
    };
  }, [
    history?.scrollback,
    history?.scrollbackSourceCols,
    open,
    terminalPanelId,
    terminalSessionId,
  ]);

  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showOverlay={false}
        className="flex h-dvh w-[min(48rem,100vw)] max-w-none flex-col gap-0 rounded-none border-l border-slate-800 bg-slate-950 p-0 text-slate-100"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
        onFocusOutside={(event) => {
          event.preventDefault();
        }}
      >
        <SheetHeader className="border-b border-slate-800 px-3 py-2 pr-12">
          <SheetTitle className="truncate text-sm text-slate-100">
            {renderedTitle}
          </SheetTitle>
          <SheetDescription className="truncate text-[11px] text-slate-400">
            {renderedStatus}
          </SheetDescription>
          <div className="grid grid-cols-1 gap-1 pt-1 text-[11px] sm:grid-cols-2">
            {idRows.map((row) => (
              <CopyableHistoryIdRow
                key={row.label}
                label={row.label}
                value={row.value}
              />
            ))}
          </div>
        </SheetHeader>
        {requestError ? (
          <p className="border-b border-slate-800 px-3 py-1.5 text-xs text-rose-400">
            {requestError}
          </p>
        ) : null}
        {loading ? (
          <p className="border-b border-slate-800 px-3 py-1.5 text-xs text-slate-400">
            Loading output...
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden p-2">
          <div
            ref={terminalContainerRef}
            className="h-full min-h-full w-full overflow-x-auto overflow-y-hidden border border-slate-800 bg-[#0b1220] px-1 py-1"
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CopyableHistoryIdRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  const displayValue = value?.trim() || "-";
  const canCopy = displayValue !== "-";
  const handleCopy = async (): Promise<void> => {
    if (!canCopy || !navigator.clipboard?.writeText) {
      return;
    }
    await navigator.clipboard.writeText(displayValue);
  };
  return (
    <div className="grid min-w-0 grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-slate-200">
        <span className="min-w-0 flex-1 truncate">{displayValue}</span>
        {canCopy ? (
          <button
            type="button"
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-100"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void handleCopy();
            }}
          >
            <Copy className="h-3 w-3" />
          </button>
        ) : null}
      </span>
    </div>
  );
}
