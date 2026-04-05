import { useCallback, useEffect, useRef, useState } from "react";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@browser-viewer/shared";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useTerminalConnection } from "../../features/terminal/use-terminal-connection";
import { HttpError } from "../../services/http";
import { createTerminalSessionClipboardImage } from "../../services/terminal";

interface TerminalSurfaceProps {
  apiBase: string;
  terminalSessionId: string;
  token: string;
  onAuthExpired?: () => void;
  onMetadata?: (metadata: { name: string; cwd: string }) => void;
}

interface PastedImageReference {
  id: string;
  label: string;
  filePath: string;
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

async function fileToBase64(file: File): Promise<string> {
  if (typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer();
    return btoa(
      Array.from(new Uint8Array(buffer), (byte) => String.fromCharCode(byte)).join(""),
    );
  }

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read clipboard image"));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read clipboard image"));
        return;
      }
      resolve(result.split(",", 2)[1] ?? "");
    };
    reader.readAsDataURL(file);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function TerminalSurface({
  apiBase,
  terminalSessionId,
  token,
  onAuthExpired,
  onMetadata,
}: TerminalSurfaceProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<PastedImageReference[]>([]);

  // onOutput is stable so it never triggers a reconnect inside
  // useTerminalConnection.
  const onOutput = useCallback((data: string) => {
    const nextChunk = data.replace(DECRQM_QUERY_RE, "");
    if (!nextChunk) {
      return;
    }

    terminalRef.current?.write(nextChunk);
  }, []);

  const {
    error,
    sendInput,
    sendResize,
  } = useTerminalConnection({
    apiBase,
    terminalSessionId,
    token,
    onAuthExpired,
    onOutput,
    onMetadata,
  });

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
      scrollback: TERMINAL_CLIENT_SCROLLBACK_LINES,
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

    let mountFitFrameId: number | null = null;
    mountFitFrameId = requestAnimationFrame(() => {
      mountFitFrameId = null;
      syncSize();
    });

    const refreshTerminalViewport = () => {
      if (!terminalRef.current || document.visibilityState !== "visible") {
        return;
      }
      syncSize();
      terminalRef.current.refresh(0, Math.max(terminalRef.current.rows - 1, 0));
    };

    let disposed = false;
    const fontFaceSet = document.fonts;
    let fontReadyPromise: Promise<unknown> | null = null;
    if (fontFaceSet?.ready) {
      fontReadyPromise = fontFaceSet.ready.then(() => {
        if (disposed) {
          return;
        }
        syncSize();
      });
    }

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

    const handlePaste = (event: ClipboardEvent) => {
      const imageItem = Array.from(event.clipboardData?.items ?? []).find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      const file = imageItem?.getAsFile();
      if (!file) {
        return;
      }

      event.preventDefault();
      setPasteError(null);

      void fileToBase64(file)
        .then((dataBase64) =>
          createTerminalSessionClipboardImage(
            apiBase,
            token,
            terminalSessionId,
            {
              mimeType: file.type,
              dataBase64,
            },
          ),
        )
        .then((payload) => {
          setPastedImages((current) => [
            ...current,
            {
              id: payload.filePath,
              label: `[Image #${current.length + 1}]`,
              filePath: payload.filePath,
            },
          ]);
          sendInput(shellQuote(payload.filePath));
        })
        .catch((nextError: unknown) => {
          if (nextError instanceof HttpError && nextError.status === 401) {
            onAuthExpired?.();
            return;
          }
          setPasteError(String(nextError));
        });
    };
    const helperTextarea = container.querySelector(".xterm-helper-textarea");
    const handlePasteEvent: EventListener = (event) => {
      handlePaste(event as ClipboardEvent);
    };
    helperTextarea?.addEventListener("paste", handlePasteEvent, true);

    return () => {
      disposed = true;
      void fontReadyPromise;
      if (mountFitFrameId !== null) {
        cancelAnimationFrame(mountFitFrameId);
        mountFitFrameId = null;
      }

      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", syncSize);
      }
      document.removeEventListener("visibilitychange", refreshTerminalViewport);
      window.removeEventListener("focus", refreshTerminalViewport);
      helperTextarea?.removeEventListener("paste", handlePasteEvent, true);
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [apiBase, onAuthExpired, sendInput, sendResize, terminalSessionId, token]);

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
        <div
          aria-label="Terminal emulator"
          className="h-full min-h-full w-full px-3 pt-2 pb-2"
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
