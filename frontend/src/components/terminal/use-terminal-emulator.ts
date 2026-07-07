import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  buildTmuxScrollInput,
  fileToBase64,
  getTerminalBottomState,
  type TerminalBottomState,
  isShiftEnterLineFeed,
  isTerminalAutoResponse,
  shellQuote,
  shouldThrottleTmuxScroll,
} from "@runweave/common/terminal";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@runweave/shared";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import type { ClientMode } from "../../features/client-mode";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  type TerminalRendererPreference,
} from "../../features/terminal/preferences";
import { createResizeScheduler } from "../../features/terminal/resize-scheduler";
import { createTerminalWrappedWebLinkProvider } from "../../features/terminal/web-link-provider";
import { shouldSuppressWheelInput } from "../../features/terminal/wheel-input";
import { HttpError } from "../../services/http";
import { createTerminalSessionClipboardImage } from "../../services/terminal";
import {
  IME_COMMIT_WINDOW_MS,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  resolveMobileBeforeInputData,
  type PastedImageReference,
  type TerminalSearchResults,
} from "./terminal-surface-utils";

const TMUX_SCROLLBACK_BOTTOM_TOLERANCE_ROWS = 2;

type MutableRef<T> = { current: T };

interface UseTerminalEmulatorArgs {
  activeRef: MutableRef<boolean>;
  apiBase: string;
  clientMode: ClientMode;
  imeCommitRef: MutableRef<{ data: string; at: number } | null>;
  imeCompositionEndedAtRef: MutableRef<number | null>;
  lastResizedAtRef: MutableRef<number | null>;
  lastSentResizeRef: MutableRef<{ cols: number; rows: number } | null>;
  onAuthExpired?: () => void;
  onBellRef: MutableRef<(() => void) | undefined>;
  onBottomStateChange: (state: TerminalBottomState) => void;
  onBufferTypeChange: (type: "normal" | "alternate" | undefined) => void;
  onTmuxScrollbackActiveChange: (active: boolean) => void;
  onUserInputData?: (data: string) => void;
  onViewportResizeRef: MutableRef<(() => void) | undefined>;
  openTerminalLinkRef: MutableRef<(uri: string) => void>;
  refreshTerminalViewportRef: MutableRef<(() => void) | null>;
  runtimeKindRef: MutableRef<"tmux" | "pty" | null>;
  searchAddonRef: MutableRef<SearchAddon | null>;
  sendResize: (cols: number, rows: number) => void;
  sendTerminalInput: (data: string) => void;
  setPasteError: Dispatch<SetStateAction<string | null>>;
  setPastedImages: Dispatch<SetStateAction<PastedImageReference[]>>;
  setSearchResults: Dispatch<SetStateAction<TerminalSearchResults | null>>;
  terminalContainerRef: MutableRef<HTMLDivElement | null>;
  terminalRef: MutableRef<Terminal | null>;
  terminalSessionId: string;
  tokenRef: MutableRef<string>;
  xtermUserInputSequenceRef: MutableRef<number>;
}

export function useTerminalEmulator({
  activeRef,
  apiBase,
  clientMode,
  imeCommitRef,
  imeCompositionEndedAtRef,
  lastResizedAtRef,
  lastSentResizeRef,
  onAuthExpired,
  onBellRef,
  onBottomStateChange,
  onBufferTypeChange,
  onTmuxScrollbackActiveChange,
  onUserInputData,
  onViewportResizeRef,
  openTerminalLinkRef,
  refreshTerminalViewportRef,
  runtimeKindRef,
  searchAddonRef,
  sendResize,
  sendTerminalInput,
  setPasteError,
  setPastedImages,
  setSearchResults,
  terminalContainerRef,
  terminalRef,
  terminalSessionId,
  tokenRef,
  xtermUserInputSequenceRef,
}: UseTerminalEmulatorArgs): void {
  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) {
      return;
    }

    const initialPreferences = DEFAULT_TERMINAL_PREFERENCES;
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const unicode11Addon = new Unicode11Addon();
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: initialPreferences.cursorBlink,
      fontFamily: initialPreferences.fontFamily,
      fontSize: initialPreferences.fontSize,
      lineHeight: 1.2,
      screenReaderMode: initialPreferences.screenReaderMode,
      scrollback: TERMINAL_CLIENT_SCROLLBACK_LINES,
      scrollSensitivity: 0.5,
      theme: {
        background: "#0b1220",
        foreground: "#e2e8f0",
        cursor: "#f8fafc",
        selectionBackground: "rgba(148, 163, 184, 0.28)",
      },
    });

    terminalRef.current = terminal;
    searchAddonRef.current = searchAddon;
    let lastBottomState: TerminalBottomState | null = null;
    const emitBottomState = () => {
      const nextBottomState = getTerminalBottomState(terminal);
      if (
        lastBottomState?.isAtBottom === nextBottomState.isAtBottom &&
        lastBottomState.bottomOffsetRows === nextBottomState.bottomOffsetRows
      ) {
        return;
      }
      lastBottomState = nextBottomState;
      onBottomStateChange(nextBottomState);
    };
    const markAwayFromBottom = () => {
      const bottomOffsetRows = Math.max(
        (lastBottomState?.bottomOffsetRows ?? 0) + 1,
        8,
      );
      if (
        lastBottomState?.isAtBottom === false &&
        lastBottomState.bottomOffsetRows === bottomOffsetRows
      ) {
        return;
      }
      lastBottomState = { isAtBottom: false, bottomOffsetRows };
      onBottomStateChange(lastBottomState);
    };
    const markTowardBottom = () => {
      const bottomOffsetRows = Math.max(
        0,
        (lastBottomState?.bottomOffsetRows ?? 0) - 1,
      );
      const nextBottomState = {
        isAtBottom: bottomOffsetRows <= TMUX_SCROLLBACK_BOTTOM_TOLERANCE_ROWS,
        bottomOffsetRows,
      };
      if (
        lastBottomState?.isAtBottom === nextBottomState.isAtBottom &&
        lastBottomState.bottomOffsetRows === nextBottomState.bottomOffsetRows
      ) {
        return nextBottomState;
      }
      lastBottomState = nextBottomState;
      onBottomStateChange(nextBottomState);
      return nextBottomState;
    };
    let lastBufferType: "normal" | "alternate" | undefined;
    const emitBufferType = () => {
      const nextBufferType = terminal.buffer.active.type;
      if (lastBufferType === nextBufferType) {
        return;
      }
      lastBufferType = nextBufferType;
      onBufferTypeChange(nextBufferType);
    };

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicode11Addon);
    const linkProviderDisposable = terminal.registerLinkProvider(
      createTerminalWrappedWebLinkProvider(terminal, {
        activate: (event, uri) => {
          event.preventDefault();
          openTerminalLinkRef.current(uri);
        },
      }),
    );
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        openTerminalLinkRef.current(uri);
      }),
    );
    terminal.open(container);
    terminal.unicode.activeVersion = "11";
    terminal.attachCustomWheelEventHandler((event) => {
      const canScroll = terminal.buffer.active.baseY > 0;
      if (!shouldSuppressWheelInput(event, canScroll)) {
        return true;
      }

      if (
        runtimeKindRef.current === "tmux" &&
        event.deltaY !== 0 &&
        !event.shiftKey
      ) {
        if (event.deltaY > 0 && lastBottomState?.isAtBottom === true) {
          onTmuxScrollbackActiveChange(false);
          event.preventDefault();
          event.stopPropagation();
          return false;
        }

        if (!shouldThrottleTmuxScroll()) {
          const input = buildTmuxScrollInput(
            event.deltaY,
            terminal.cols,
            terminal.rows,
          );
          if (input) {
            sendTerminalInput(input);
            if (event.deltaY < 0) {
              markAwayFromBottom();
              onTmuxScrollbackActiveChange(true);
            } else {
              const nextBottomState = markTowardBottom();
              if (nextBottomState.isAtBottom) {
                onTmuxScrollbackActiveChange(false);
              }
            }
          }
        }
      }

      event.preventDefault();
      event.stopPropagation();
      return false;
    });

    let rendererAddon: { dispose(): void } | null = null;
    const applyRendererPreference = (
      preference: TerminalRendererPreference,
    ) => {
      rendererAddon?.dispose();
      rendererAddon = null;

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
              return;
            }
          });
          terminal.loadAddon(webgl);
          rendererAddon = webgl;
          return true;
        } catch {
          if (allowCanvasFallback) {
            return loadCanvas();
          }
          return loadCanvas();
        }
      };

      if (preference === "dom") {
        return;
      }

      if (preference === "canvas") {
        loadCanvas();
        return;
      }

      if (preference === "webgl") {
        loadWebgl(false);
        return;
      }

      loadWebgl(true);
    };
    applyRendererPreference(initialPreferences.renderer);

    const syncSize = () => {
      fitAddon.fit();
      const dimensions = fitAddon.proposeDimensions();
      if (!dimensions) {
        return;
      }
      if (
        lastSentResizeRef.current?.cols === dimensions.cols &&
        lastSentResizeRef.current.rows === dimensions.rows
      ) {
        return;
      }
      lastResizedAtRef.current = Date.now();
      lastSentResizeRef.current = {
        cols: dimensions.cols,
        rows: dimensions.rows,
      };
      sendResize(dimensions.cols, dimensions.rows);
      onViewportResizeRef.current?.();
    };
    const resizeScheduler = createResizeScheduler(
      syncSize,
      TERMINAL_RESIZE_DEBOUNCE_MS,
    );
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (!DEFAULT_TERMINAL_PREFERENCES.copyOnSelect) {
        return;
      }

      const selection = terminal.getSelection();
      if (!selection || !navigator.clipboard?.writeText) {
        return;
      }

      void navigator.clipboard.writeText(selection).catch(() => undefined);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "PageUp" || event.key === "PageDown")
      ) {
        event.preventDefault();
        terminal.scrollPages(event.key === "PageUp" ? -1 : 1);
        emitBufferType();
        emitBottomState();
        return false;
      }

      if (isShiftEnterLineFeed(event)) {
        event.preventDefault();
        onUserInputData?.("\n");
        sendTerminalInput("\n");
        return false;
      }

      return true;
    });
    const dataDisposable = terminal.onData((data) => {
      if (isTerminalAutoResponse(data)) {
        return;
      }
      xtermUserInputSequenceRef.current += 1;
      onUserInputData?.(data);
      sendTerminalInput(data);
    });
    const bellDisposable = terminal.onBell(() => {
      if (!activeRef.current) {
        onBellRef.current?.();
      }
    });
    const scrollDisposable = terminal.onScroll(() => {
      emitBufferType();
      emitBottomState();
    });
    const renderDisposable = terminal.onRender(() => {
      emitBufferType();
    });

    syncSize();
    emitBufferType();

    let mountFitFrameId: number | null = null;
    mountFitFrameId = requestAnimationFrame(() => {
      mountFitFrameId = null;
      syncSize();
      emitBottomState();
    });
    const searchResultsDisposable = searchAddon.onDidChangeResults(
      (results) => {
        setSearchResults(
          results
            ? {
                resultCount: results.resultCount,
                resultIndex: results.resultIndex,
              }
            : null,
        );
      },
    );

    const refreshTerminalViewport = () => {
      if (!terminalRef.current || document.visibilityState !== "visible") {
        return;
      }
      syncSize();
      terminalRef.current.refresh(0, Math.max(terminalRef.current.rows - 1, 0));
    };
    refreshTerminalViewportRef.current = refreshTerminalViewport;

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
        resizeScheduler.schedule();
      });
      resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", resizeScheduler.schedule);
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
      event.stopImmediatePropagation();
      setPasteError(null);

      void fileToBase64(file)
        .then((dataBase64) =>
          createTerminalSessionClipboardImage(
            apiBase,
            tokenRef.current,
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
          sendTerminalInput(shellQuote(payload.filePath));
        })
        .catch((nextError: unknown) => {
          if (nextError instanceof HttpError && nextError.status === 401) {
            onAuthExpired?.();
            return;
          }
          setPasteError(String(nextError));
        });
    };
    const helperTextarea = container.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    const handlePasteEvent: EventListener = (event) => {
      handlePaste(event as ClipboardEvent);
    };
    const handleMobileBeforeInput: EventListener = (event) => {
      if (clientMode !== "mobile" || !helperTextarea) {
        return;
      }

      const inputEvent = event as InputEvent;
      const data = resolveMobileBeforeInputData(inputEvent, helperTextarea);
      if (!data) {
        return;
      }

      const xtermUserInputSequence = xtermUserInputSequenceRef.current;
      window.setTimeout(() => {
        if (disposed) {
          return;
        }
        if (xtermUserInputSequenceRef.current !== xtermUserInputSequence) {
          return;
        }

        sendTerminalInput(data);
      }, 20);
    };
    const handleCompositionEnd: EventListener = (event) => {
      const compositionEvent = event as CompositionEvent;
      imeCompositionEndedAtRef.current = performance.now();
      if (compositionEvent.data) {
        imeCommitRef.current = {
          data: compositionEvent.data,
          at: imeCompositionEndedAtRef.current,
        };
      }
    };
    const handleBeforeInput: EventListener = (event) => {
      const inputEvent = event as InputEvent;
      const compositionEndedAt = imeCompositionEndedAtRef.current;
      if (
        inputEvent.inputType !== "insertText" ||
        !inputEvent.data ||
        compositionEndedAt === null ||
        performance.now() - compositionEndedAt > IME_COMMIT_WINDOW_MS
      ) {
        return;
      }

      imeCommitRef.current = {
        data: inputEvent.data,
        at: performance.now(),
      };
    };
    helperTextarea?.addEventListener("paste", handlePasteEvent, true);
    helperTextarea?.addEventListener(
      "compositionend",
      handleCompositionEnd,
      true,
    );
    helperTextarea?.addEventListener("beforeinput", handleBeforeInput, true);
    helperTextarea?.addEventListener(
      "beforeinput",
      handleMobileBeforeInput,
      true,
    );

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
        window.removeEventListener("resize", resizeScheduler.schedule);
      }
      document.removeEventListener("visibilitychange", refreshTerminalViewport);
      window.removeEventListener("focus", refreshTerminalViewport);
      helperTextarea?.removeEventListener("paste", handlePasteEvent, true);
      helperTextarea?.removeEventListener(
        "compositionend",
        handleCompositionEnd,
        true,
      );
      helperTextarea?.removeEventListener(
        "beforeinput",
        handleBeforeInput,
        true,
      );
      helperTextarea?.removeEventListener(
        "beforeinput",
        handleMobileBeforeInput,
        true,
      );
      searchResultsDisposable.dispose();
      dataDisposable.dispose();
      bellDisposable.dispose();
      scrollDisposable.dispose();
      renderDisposable.dispose();
      selectionDisposable.dispose();
      linkProviderDisposable.dispose();
      resizeScheduler.dispose();
      rendererAddon?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      refreshTerminalViewportRef.current = null;
      searchAddonRef.current = null;
    };
  }, [
    activeRef,
    apiBase,
    clientMode,
    imeCommitRef,
    imeCompositionEndedAtRef,
    lastResizedAtRef,
    lastSentResizeRef,
    onAuthExpired,
    onBellRef,
    onBottomStateChange,
    onBufferTypeChange,
    onTmuxScrollbackActiveChange,
    onUserInputData,
    onViewportResizeRef,
    openTerminalLinkRef,
    refreshTerminalViewportRef,
    runtimeKindRef,
    searchAddonRef,
    sendResize,
    sendTerminalInput,
    setPasteError,
    setPastedImages,
    setSearchResults,
    terminalContainerRef,
    terminalRef,
    terminalSessionId,
    tokenRef,
    xtermUserInputSequenceRef,
  ]);
}
