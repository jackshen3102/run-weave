import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@browser-viewer/shared";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { TerminalSessionStatusResponse } from "@browser-viewer/shared";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useTerminalConnection } from "../features/terminal/use-terminal-connection";
import { HttpError } from "../services/http";
import { getTerminalSession } from "../services/terminal";

interface TerminalPageProps {
  apiBase: string;
  terminalSessionId: string;
  token: string;
  onAuthExpired?: () => void;
}

function renderCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

const ESCAPE = "\\u001b";
const BELL = "\\u0007";
const OSC_COLOR_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\]1[01];rgb:[0-9a-f/]+(?:${BELL}|${ESCAPE}\\\\)`,
  "i",
);
const DECRPM_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[\\?[0-9;]+\\$y`);
const DCS_RESPONSE_PATTERN = new RegExp(`${ESCAPE}P[01]\\$r.*${ESCAPE}\\\\`);
const CURSOR_POSITION_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]+R`);
const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\[(?:\\?|>)[0-9;]+c`,
);

// xterm.js 6.0.0 has a bug in requestMode(): the handler for DECRQM queries
// (CSI ? Pn $ p) crashes with "r is not defined". Vim sends these to probe
// terminal mode capabilities. Strip them before writing — xterm cannot respond
// to them anyway, and vim falls back to defaults when it receives no reply.
const DECRQM_QUERY_RE = new RegExp(`${ESCAPE}\\[\\?[\\d;]+\\$p`, "g");

function isTerminalAutoResponse(data: string): boolean {
  if (!data.startsWith("\u001b")) {
    return false;
  }

  return (
    OSC_COLOR_RESPONSE_PATTERN.test(data) ||
    DECRPM_RESPONSE_PATTERN.test(data) ||
    DCS_RESPONSE_PATTERN.test(data) ||
    CURSOR_POSITION_RESPONSE_PATTERN.test(data) ||
    DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data)
  );
}

export function TerminalPage({
  apiBase,
  terminalSessionId,
  token,
  onAuthExpired,
}: TerminalPageProps) {
  const [session, setSession] = useState<TerminalSessionStatusResponse | null>(
    null,
  );
  const [requestError, setRequestError] = useState<string | null>(null);
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);

  const onOutput = useCallback((data: string) => {
    const nextChunk = data.replace(DECRQM_QUERY_RE, "");
    if (!nextChunk) {
      return;
    }

    terminalRef.current?.write(nextChunk);
  }, []);

  const {
    connectionStatus,
    terminalStatus,
    exitCode,
    error,
    sendInput,
    sendResize,
  } = useTerminalConnection({
    apiBase,
    terminalSessionId,
    token,
    onAuthExpired,
    onOutput,
  });

  const renderedCommand = useMemo(() => {
    return session ? renderCommand(session.command, session.args) : "Loading...";
  }, [session]);
  const renderedTerminalStatus = useMemo(() => {
    const effectiveStatus = terminalStatus ?? session?.status ?? "running";
    if (effectiveStatus === "exited") {
      return exitCode == null ? "Exited" : `Exited (${exitCode})`;
    }
    return "running";
  }, [exitCode, session?.status, terminalStatus]);
  const renderedConnectionStatus = useMemo(() => {
    return connectionStatus === "connected" ? "live" : "offline";
  }, [connectionStatus]);

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) {
      return;
    }

    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: "\"Fira Code\", \"SFMono-Regular\", ui-monospace, monospace",
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: TERMINAL_CLIENT_SCROLLBACK_LINES,
      theme: {
        background: "#0f172a",
        foreground: "#e2e8f0",
        cursor: "#f8fafc",
        selectionBackground: "rgba(148, 163, 184, 0.28)",
      },
    });

    terminalRef.current = terminal;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);
    terminal.unicode.activeVersion = "11";

    // Renderer: try WebGL → Canvas → DOM fallback.
    (() => {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          try {
            terminal.loadAddon(new CanvasAddon());
          } catch {
            // fall through to DOM renderer
          }
        });
        terminal.loadAddon(webgl);
      } catch {
        try {
          terminal.loadAddon(new CanvasAddon());
        } catch {
          // DOM renderer is the implicit fallback
        }
      }
    })();

    terminal.focus();

    const syncSize = () => {
      fitAddon.fit();
      const dimensions = fitAddon.proposeDimensions();
      if (!dimensions) {
        return;
      }
      sendResize(dimensions.cols, dimensions.rows);
    };

    const dataDisposable = terminal.onData((data) => {
      if (isTerminalAutoResponse(data)) {
        return;
      }
      sendInput(data);
    });

    syncSize();

    const refreshTerminalViewport = () => {
      if (!terminalRef.current || document.visibilityState !== "visible") {
        return;
      }
      syncSize();
      terminalRef.current.refresh(0, Math.max(terminalRef.current.rows - 1, 0));
    };

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        syncSize();
      });
      resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", syncSize);
    }

    document.addEventListener("visibilitychange", refreshTerminalViewport);
    window.addEventListener("focus", refreshTerminalViewport);

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", syncSize);
      }
      document.removeEventListener("visibilitychange", refreshTerminalViewport);
      window.removeEventListener("focus", refreshTerminalViewport);
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sendInput, sendResize, terminalSessionId]);

  useEffect(() => {
    let cancelled = false;

    void getTerminalSession(apiBase, token, terminalSessionId)
      .then((nextSession) => {
        if (cancelled) {
          return;
        }
        setSession(nextSession);
      })
      .catch((nextError: unknown) => {
        if (cancelled) {
          return;
        }
        if (nextError instanceof HttpError && nextError.status === 401) {
          onAuthExpired?.();
          return;
        }
        setRequestError(String(nextError));
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, onAuthExpired, terminalSessionId, token]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4">
        <h1 className="text-xl font-semibold">
          {session?.name ?? "Terminal Session"}
        </h1>
        <p className="mt-1 text-sm text-slate-400">{renderedCommand}</p>
        <div className="mt-2 flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-slate-500">
          <span>{renderedTerminalStatus}</span>
          <span>{renderedConnectionStatus}</span>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {requestError ? (
          <p className="text-sm text-rose-400">{requestError}</p>
        ) : null}
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div
            aria-label="Terminal emulator"
            className="h-full min-h-full w-full p-3"
            role="application"
            tabIndex={0}
            onClick={() => terminalRef.current?.focus()}
            onFocus={() => terminalRef.current?.focus()}
            ref={terminalContainerRef}
          />
        </div>
      </main>
    </div>
  );
}
