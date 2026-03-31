import { useCallback, useEffect, useMemo, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useTerminalConnection } from "../../features/terminal/use-terminal-connection";

interface TerminalSurfaceProps {
  apiBase: string;
  terminalSessionId: string;
  token: string;
  onAuthExpired?: () => void;
}

const ESCAPE = "\\u001b";
const BELL = "\\u0007";
const OSC_COLOR_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\]1[01];rgb:[0-9a-f/]+(?:${BELL}|${ESCAPE}\\\\)`,
  "i",
);
const DECRPM_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[\\?[0-9;]+\\$y`);
const DCS_RESPONSE_PATTERN = new RegExp(`${ESCAPE}P[01]\\$r.*${ESCAPE}\\\\`);

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
    DCS_RESPONSE_PATTERN.test(data)
  );
}

export function TerminalSurface({
  apiBase,
  terminalSessionId,
  token,
  onAuthExpired,
}: TerminalSurfaceProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);

  // RAF-based write batching: accumulate chunks within a frame, flush in one write.
  const pendingChunksRef = useRef<string[]>([]);
  const rafIdRef = useRef<number | null>(null);
  // Stable write handler stored in a ref so onOutput below never changes identity.
  const writeChunkRef = useRef<((data: string) => void) | null>(null);

  // onOutput is stable (empty deps + writeChunkRef indirection) so it never
  // triggers a reconnect inside useTerminalConnection.
  const onOutput = useCallback((data: string) => {
    writeChunkRef.current?.(data);
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

  const renderedTerminalStatus = useMemo(() => {
    const effectiveStatus = terminalStatus ?? "running";
    if (effectiveStatus === "exited") {
      return exitCode == null ? "Exited" : `Exited (${exitCode})`;
    }

    return "running";
  }, [exitCode, terminalStatus]);

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
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: "#0b1220",
        foreground: "#e2e8f0",
        cursor: "#f8fafc",
        selectionBackground: "rgba(148, 163, 184, 0.28)",
      },
    });

    terminalRef.current = terminal;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11Addon);
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

    // RAF batching: buffer chunks arriving within the same frame and flush together.
    const flushPending = () => {
      rafIdRef.current = null;
      if (!terminalRef.current || pendingChunksRef.current.length === 0) {
        return;
      }
      const batch = pendingChunksRef.current.join("").replace(DECRQM_QUERY_RE, "");
      pendingChunksRef.current = [];
      if (batch) terminalRef.current.write(batch);
    };

    writeChunkRef.current = (data: string) => {
      pendingChunksRef.current.push(data);
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushPending);
      }
    };

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

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        syncSize();
      });
      resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", syncSize);
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingChunksRef.current = [];
      writeChunkRef.current = null;

      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", syncSize);
      }
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sendInput, sendResize, terminalSessionId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-800/90 px-3 py-2 text-xs uppercase tracking-[0.22em] text-slate-400">
        <span>{renderedTerminalStatus}</span>
        <span>{connectionStatus === "connected" ? "live" : "offline"}</span>
      </div>
      {error ? <p className="px-3 py-2 text-xs text-rose-400">{error}</p> : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
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
    </div>
  );
}
