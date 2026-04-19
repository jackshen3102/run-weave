import { useEffect, useMemo, useRef, useState } from "react";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@browser-viewer/shared";
import type { TerminalSessionHistoryResponse } from "@browser-viewer/shared";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  syncTerminalHistorySize,
  writeTerminalHistoryOutput,
} from "../../features/terminal/history-output";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import { loadTerminalPreferences } from "../../features/terminal/preferences";
import { HttpError } from "../../services/http";
import { getTerminalHistory } from "../../services/terminal";
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
  terminalName?: string;
  onOpenChange: (open: boolean) => void;
  onAuthExpired?: () => void;
}

function countTerminalLines(output: string): number {
  if (!output) {
    return 0;
  }

  let lines = 1;
  for (let index = 0; index < output.length; index += 1) {
    if (output.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
}

export function TerminalHistoryDrawer({
  open,
  apiBase,
  token,
  terminalSessionId,
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

    void getTerminalHistory(apiBase, token, terminalSessionId)
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
  }, [apiBase, onAuthExpired, open, terminalSessionId, token]);

  const renderedTitle =
    terminalName ??
    (history
      ? formatTerminalSessionName({
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

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!open || !container) {
      return;
    }

    const preferences = loadTerminalPreferences(apiBase);
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
    apiBase,
    history?.scrollback,
    history?.scrollbackSourceCols,
    open,
    terminalSessionId,
  ]);

  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showOverlay={false}
        className="flex h-[calc(100vh-1rem)] w-[min(52rem,calc(100vw-1rem))] max-w-none flex-col gap-0 rounded-l-lg border-slate-800 bg-slate-950 p-0 text-slate-100"
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
        <SheetHeader className="border-b border-slate-800 px-4 py-3 pr-14">
          <SheetTitle className="truncate text-slate-100">{renderedTitle}</SheetTitle>
          <SheetDescription className="truncate text-xs text-slate-400">
            {renderedStatus}
          </SheetDescription>
        </SheetHeader>
        {requestError ? (
          <p className="border-b border-slate-800 px-4 py-2 text-xs text-rose-400">
            {requestError}
          </p>
        ) : null}
        {loading ? (
          <p className="border-b border-slate-800 px-4 py-2 text-xs text-slate-400">
            Loading output...
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden p-3">
          <div
            ref={terminalContainerRef}
            className="h-full min-h-full w-full overflow-x-auto overflow-y-hidden rounded-md border border-slate-800 bg-[#0b1220] px-1 py-1"
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
