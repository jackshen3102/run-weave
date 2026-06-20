import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type FocusEvent,
} from "react";
import {
  isTerminalAtBottom,
  isShiftEnterLineFeed,
  isTerminalAutoResponse,
  scrollTerminalToBottom,
} from "@runweave/common/terminal";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type {
  TerminalRendererDisposable,
  TerminalRendererHandle,
  TerminalRendererPreference,
  TerminalRendererProps,
  TerminalRendererTheme,
} from "./terminal-renderer-types";

const DEFAULT_THEME: TerminalRendererTheme = {
  background: "#0b1220",
  foreground: "#e2e8f0",
  cursor: "#f8fafc",
  selectionBackground: "rgba(148, 163, 184, 0.28)",
};

const DEFAULT_FONT_FAMILY =
  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
const RESIZE_DEBOUNCE_MS = 80;

function disposeRendererDisposable(disposable: TerminalRendererDisposable): void {
  if (typeof disposable === "function") {
    disposable();
    return;
  }
  disposable.dispose();
}

function applyRendererPreference(
  terminal: Terminal,
  preference: TerminalRendererPreference,
): { dispose(): void } | null {
  let rendererAddon: { dispose(): void } | null = null;

  const loadCanvas = (): boolean => {
    try {
      const canvas = new CanvasAddon();
      terminal.loadAddon(canvas);
      rendererAddon = canvas;
      return true;
    } catch {
      return false;
    }
  };

  const loadWebgl = (allowCanvasFallback: boolean): boolean => {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (allowCanvasFallback) {
          loadCanvas();
        }
      });
      terminal.loadAddon(webgl);
      rendererAddon = webgl;
      return true;
    } catch {
      return allowCanvasFallback ? loadCanvas() : false;
    }
  };

  if (preference === "dom") {
    return null;
  }
  if (preference === "canvas") {
    loadCanvas();
    return rendererAddon;
  }
  if (preference === "webgl") {
    loadWebgl(false);
    return rendererAddon;
  }
  loadWebgl(true);
  return rendererAddon;
}

export const TerminalRenderer = forwardRef<
  TerminalRendererHandle,
  TerminalRendererProps
>(function TerminalRenderer(
  {
    active,
    className,
    focusOnInteraction = true,
    fontFamily = DEFAULT_FONT_FAMILY,
    fontSize = 13,
    lineHeight = 1.2,
    renderer = "auto",
    scrollbackLines = 5000,
    theme = DEFAULT_THEME,
    onBell,
    onBottomStateChange,
    onInput,
    onResize,
    onTerminalReady,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const onBellRef = useRef(onBell);
  const onBottomStateChangeRef = useRef(onBottomStateChange);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const resizeTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastBottomStateRef = useRef<boolean | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    onBellRef.current = onBell;
  }, [onBell]);
  useEffect(() => {
    onBottomStateChangeRef.current = onBottomStateChange;
  }, [onBottomStateChange]);
  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  const fit = () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return;
    }
    fitAddon.fit();
    const dimensions = fitAddon.proposeDimensions();
    if (!dimensions) {
      return;
    }
    if (
      lastSizeRef.current?.cols === dimensions.cols &&
      lastSizeRef.current.rows === dimensions.rows
    ) {
      return;
    }
    lastSizeRef.current = dimensions;
    onResizeRef.current?.(dimensions.cols, dimensions.rows);
  };

  const refresh = () => {
    const terminal = terminalRef.current;
    if (!terminal || document.visibilityState !== "visible") {
      return;
    }
    fit();
    terminal.refresh(0, Math.max(terminal.rows - 1, 0));
  };

  const emitBottomState = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const isAtBottom = isTerminalAtBottom(terminal);
    if (lastBottomStateRef.current === isAtBottom) {
      return;
    }
    lastBottomStateRef.current = isAtBottom;
    onBottomStateChangeRef.current?.(isAtBottom);
  };

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        terminalRef.current?.focus();
      },
      fit,
      refresh,
      resetAndWrite(data: string) {
        const terminal = terminalRef.current;
        if (!terminal) {
          return;
        }
        terminal.reset();
        if (!data) {
          emitBottomState();
          refresh();
          return;
        }
        terminal.write(data, () => {
          scrollTerminalToBottom(terminal);
          emitBottomState();
          refresh();
        });
      },
      write(data: string) {
        terminalRef.current?.write(data, emitBottomState);
      },
      clear() {
        terminalRef.current?.clear();
        emitBottomState();
      },
      scrollToBottom() {
        const terminal = terminalRef.current;
        if (!terminal) {
          return;
        }
        scrollTerminalToBottom(terminal);
        emitBottomState();
      },
      isAtBottom() {
        const terminal = terminalRef.current;
        return terminal ? isTerminalAtBottom(terminal) : true;
      },
      getTerminal() {
        return terminalRef.current;
      },
    }),
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily,
      fontSize,
      lineHeight,
      scrollback: scrollbackLines,
      scrollSensitivity: 0.5,
      theme,
    });
    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11Addon);
    const rendererAddon = applyRendererPreference(terminal, renderer);

    terminal.open(container);
    terminal.unicode.activeVersion = "11";

    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (isShiftEnterLineFeed(event)) {
        event.preventDefault();
        onInputRef.current?.("\n");
        return false;
      }
      return true;
    });
    const dataDisposable = terminal.onData((data) => {
      if (isTerminalAutoResponse(data)) {
        return;
      }
      onInputRef.current?.(data);
    });
    const bellDisposable = terminal.onBell(() => {
      onBellRef.current?.();
    });
    const scrollDisposable = terminal.onScroll(() => {
      emitBottomState();
    });

    const scheduleFit = () => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        fit();
      }, RESIZE_DEBOUNCE_MS);
    };

    let mountFitFrameId: number | null = requestAnimationFrame(() => {
      mountFitFrameId = null;
      fit();
      emitBottomState();
    });
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", scheduleFit);
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);

    const extensionDisposables = onTerminalReady?.({
      terminal,
      container,
      fit,
      refresh,
    });
    const normalizedDisposables = Array.isArray(extensionDisposables)
      ? extensionDisposables
      : extensionDisposables
        ? [extensionDisposables]
        : [];

    return () => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (mountFitFrameId !== null) {
        cancelAnimationFrame(mountFitFrameId);
        mountFitFrameId = null;
      }
      for (const disposable of normalizedDisposables) {
        disposeRendererDisposable(disposable);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", scheduleFit);
      }
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      terminal.attachCustomKeyEventHandler(() => true);
      dataDisposable.dispose();
      bellDisposable.dispose();
      scrollDisposable.dispose();
      rendererAddon?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastSizeRef.current = null;
      lastBottomStateRef.current = null;
    };
  }, [
    fontFamily,
    fontSize,
    lineHeight,
    onTerminalReady,
    renderer,
    scrollbackLines,
    theme,
  ]);

  const handleClick = () => {
    if (!focusOnInteraction) {
      return;
    }
    if (activeRef.current) {
      terminalRef.current?.focus();
    }
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!focusOnInteraction) {
      return;
    }
    event.currentTarget.blur();
    if (activeRef.current) {
      terminalRef.current?.focus();
    }
  };

  return (
    <div
      aria-label="Terminal emulator"
      className={["terminal-renderer", className].filter(Boolean).join(" ")}
      onClick={handleClick}
      onFocus={handleFocus}
      ref={containerRef}
      role="application"
      tabIndex={focusOnInteraction ? 0 : undefined}
    />
  );
});
