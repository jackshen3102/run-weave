import { useEffect, useMemo, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
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
  const renderedOutputLengthRef = useRef(0);
  const {
    connectionStatus,
    terminalStatus,
    exitCode,
    error,
    output,
    clearOutput,
    sendInput,
    sendResize,
  } = useTerminalConnection({
    apiBase,
    terminalSessionId,
    token,
    onAuthExpired,
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
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "\"Fira Code\", \"SFMono-Regular\", ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#0b1220",
        foreground: "#e2e8f0",
        cursor: "#f8fafc",
        selectionBackground: "rgba(148, 163, 184, 0.28)",
      },
    });

    terminalRef.current = terminal;
    renderedOutputLengthRef.current = 0;

    terminal.loadAddon(fitAddon);
    terminal.open(container);
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

    let resizeObserver: ResizeObserver | null = null;
    const handleWindowResize = () => {
      syncSize();
    };

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        syncSize();
      });
      resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", handleWindowResize);
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", handleWindowResize);
      }
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      renderedOutputLengthRef.current = 0;
      clearOutput();
    };
  }, [clearOutput, sendInput, sendResize, terminalSessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const nextChunk =
      output.length >= renderedOutputLengthRef.current
        ? output.slice(renderedOutputLengthRef.current)
        : output;
    if (!nextChunk) {
      return;
    }

    terminal.write(nextChunk);
    renderedOutputLengthRef.current = output.length;
  }, [output]);

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
        <pre aria-label="Terminal output" className="sr-only">
          {output || "$ "}
        </pre>
      </div>
    </div>
  );
}
