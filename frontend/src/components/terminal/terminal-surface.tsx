import { useCallback, useEffect, useRef, useState } from "react";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@browser-viewer/shared";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { Settings2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  containsTerminalActivityContent,
  shouldEmitTerminalActivityPulse,
  shouldMarkTerminalActivity,
} from "../../features/terminal/activity-marker";
import { createTerminalBellPlayer } from "../../features/terminal/bell";
import type { ClientMode } from "../../features/client-mode";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  type TerminalPreferences,
  type TerminalRendererPreference,
  loadTerminalPreferences,
  saveTerminalPreferences,
} from "../../features/terminal/preferences";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../../features/terminal/perf-logging";
import { filterBrowserHandledTerminalOutput } from "../../features/terminal/output-filter";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { createResizeScheduler } from "../../features/terminal/resize-scheduler";
import { buildTmuxScrollInput, shouldThrottleTmuxScroll } from "../../features/terminal/tmux-scroll";
import { useTerminalConnection } from "../../features/terminal/use-terminal-connection";
import { scheduleTerminalViewportRefresh } from "../../features/terminal/viewport-refresh";
import { shouldSuppressWheelInput } from "../../features/terminal/wheel-input";
import { HttpError } from "../../services/http";
import {
  createTerminalSessionClipboardImage,
  getTerminalSession,
} from "../../services/terminal";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TerminalMobileKeybar } from "./terminal-mobile-keybar";

interface TerminalSurfaceProps {
  active: boolean;
  apiBase: string;
  terminalSessionId: string;
  token: string;
  clientMode?: ClientMode;
  layoutVersion?: string;
  onAuthExpired?: () => void;
  onActivity?: () => void;
  onBell?: () => void;
  onMetadata?: (metadata: { cwd: string; activeCommand: string | null }) => void;
  onOpenHistory?: () => void;
}

interface PastedImageReference {
  id: string;
  label: string;
  filePath: string;
}

const ESCAPE = "\\u001b";
const BELL = "\\u0007";
const BELL_CHARACTER = "\u0007";
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
const FOCUS_REPORTING_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[(?:I|O)$`);
const TERMINAL_RESIZE_DEBOUNCE_MS = 120;
const MIN_TERMINAL_FONT_SIZE = 11;
const MAX_TERMINAL_FONT_SIZE = 24;
const DEFERRED_OUTPUT_REPLAY_MAX_CHARS = 128 * 1024;

interface TerminalSearchResults {
  resultCount: number;
  resultIndex: number;
}

type ActiveRenderer = "webgl" | "canvas" | "dom";

function recordTerminalPerfProbeEvent(
  event: string,
  data: string,
  details: Record<string, unknown>,
): void {
  const target = window as unknown as {
    __terminalPerfProbeEvents?: Array<{
      event: string;
      at: number;
      details: Record<string, unknown>;
    }>;
  };
  if (!target.__terminalPerfProbeEvents) {
    return;
  }

  const probeText = data.match(/BV_[^\s\r\n]+/)?.[0];
  if (!probeText) {
    return;
  }

  target.__terminalPerfProbeEvents.push({
    event,
    at: performance.now(),
    details: {
      ...details,
      probeText,
    },
  });
}

function clampTerminalFontSize(value: number): number {
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, value));
}

function isTerminalAutoResponse(data: string): boolean {
  if (!data.startsWith("\u001b")) {
    return false;
  }

  return (
    OSC_COLOR_RESPONSE_PATTERN.test(data) ||
    DECRPM_RESPONSE_PATTERN.test(data) ||
    DCS_RESPONSE_PATTERN.test(data) ||
    CURSOR_POSITION_RESPONSE_PATTERN.test(data) ||
    DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data) ||
    FOCUS_REPORTING_RESPONSE_PATTERN.test(data)
  );
}

function isShiftEnterLineFeed(event: KeyboardEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

async function fileToBase64(file: File): Promise<string> {
  if (typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer();
    return btoa(
      Array.from(new Uint8Array(buffer), (byte) =>
        String.fromCharCode(byte),
      ).join(""),
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

function resolveMobileBeforeInputData(
  event: InputEvent,
  helperTextarea: HTMLTextAreaElement,
): string | null {
  if (
    event.inputType === "insertText" ||
    event.inputType === "insertReplacementText" ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromPaste"
  ) {
    return (event.data ?? helperTextarea.value) || null;
  }

  if (
    event.inputType === "insertLineBreak" ||
    event.inputType === "insertParagraph"
  ) {
    return "\r";
  }

  if (event.inputType === "deleteContentBackward") {
    return "\u007f";
  }

  if (event.inputType === "deleteContentForward") {
    return "\u001b[3~";
  }

  return null;
}

export function TerminalSurface({
  active,
  apiBase,
  terminalSessionId,
  token,
  clientMode = "desktop",
  layoutVersion = "default",
  onAuthExpired,
  onActivity,
  onBell,
  onMetadata,
  onOpenHistory,
}: TerminalSurfaceProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const createBrowserTab = useTerminalPreviewStore(
    (state) => state.createBrowserTab,
  );
  const openBrowser = useTerminalPreviewStore((state) => state.openBrowser);
  const refreshTerminalViewportRef = useRef<(() => void) | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const applyRendererPreferenceRef = useRef<
    ((preference: TerminalRendererPreference) => void) | null
  >(null);
  const bellPlayerRef = useRef(createTerminalBellPlayer());
  const activeRef = useRef(active);
  const onActivityRef = useRef(onActivity);
  const onBellRef = useRef(onBell);
  const onAuthExpiredRef = useRef(onAuthExpired);
  const openTerminalLinkRef = useRef<(uri: string) => void>(() => undefined);
  const onMetadataRef = useRef(onMetadata);
  const tokenRef = useRef(token);
  const runtimeKindRef = useRef<"tmux" | "pty" | null>(null);
  const openedAtRef = useRef(Date.now());
  const lastActivityMarkedAtRef = useRef<number | null>(null);
  const lastResizedAtRef = useRef<number | null>(null);
  const inputSequenceRef = useRef(0);
  const outputSequenceRef = useRef(0);
  const xtermUserInputSequenceRef = useRef(0);
  const lastInputSentAtRef = useRef<number | null>(null);
  const hasDeferredOutputRef = useRef(false);
  const deferredOutputRef = useRef("");
  const requiresSnapshotRestoreRef = useRef(false);
  const hasRenderedSnapshotRef = useRef(false);
  const restoreSnapshotRequestRef = useRef(0);
  const websocketContentVersionRef = useRef(0);
  const lastSentResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<PastedImageReference[]>([]);
  const [preferences, setPreferences] = useState<TerminalPreferences>(() =>
    loadTerminalPreferences(apiBase),
  );
  const preferencesRef = useRef(preferences);
  const [effectiveRenderer, setEffectiveRenderer] =
    useState<ActiveRenderer>("dom");
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [mobileKeybarOpen, setMobileKeybarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] =
    useState<TerminalSearchResults | null>(null);
  const [searchOptions, setSearchOptions] = useState({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });

  const renderTerminalSnapshot = useCallback((data: string) => {
    const nextChunk = filterBrowserHandledTerminalOutput(data);
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    logTerminalPerf("terminal.snapshot.received", {
      terminalSessionId,
      ...summarizeTerminalChunk(nextChunk),
    });

    hasRenderedSnapshotRef.current = true;
    hasDeferredOutputRef.current = false;
    deferredOutputRef.current = "";
    requiresSnapshotRestoreRef.current = false;
    terminal.reset();
    if (!nextChunk) {
      refreshTerminalViewportRef.current?.();
      return;
    }

    const renderStartedAt = performance.now();
    terminal.write(nextChunk, () => {
      logTerminalPerf("terminal.snapshot.rendered", {
        terminalSessionId,
        renderDurationMs: Number((performance.now() - renderStartedAt).toFixed(2)),
        ...summarizeTerminalChunk(nextChunk),
      });
      terminal.scrollToBottom();
      refreshTerminalViewportRef.current?.();
    });
  }, [terminalSessionId]);

  const markDeferredOutput = useCallback((data: string) => {
    hasDeferredOutputRef.current = true;

    if (requiresSnapshotRestoreRef.current) {
      return;
    }

    if (
      deferredOutputRef.current.length + data.length >
      DEFERRED_OUTPUT_REPLAY_MAX_CHARS
    ) {
      deferredOutputRef.current = "";
      requiresSnapshotRestoreRef.current = true;
      return;
    }

    deferredOutputRef.current += data;
  }, []);

  const replayDeferredOutput = useCallback(() => {
    const terminal = terminalRef.current;
    const deferredOutput = deferredOutputRef.current;
    if (!terminal || !deferredOutput) {
      return false;
    }

    deferredOutputRef.current = "";
    hasDeferredOutputRef.current = false;

    const renderStartedAt = performance.now();
    terminal.write(deferredOutput, () => {
      logTerminalPerf("terminal.deferred-output.rendered", {
        terminalSessionId,
        renderDurationMs: Number((performance.now() - renderStartedAt).toFixed(2)),
        ...summarizeTerminalChunk(deferredOutput),
      });
      refreshTerminalViewportRef.current?.();
    });

    return true;
  }, [terminalSessionId]);

  // onOutput is stable so it never triggers a reconnect inside
  // useTerminalConnection.
  const onSnapshot = useCallback((data: string) => {
    websocketContentVersionRef.current += 1;
    if (!activeRef.current) {
      if (terminalRef.current) {
        renderTerminalSnapshot(data);
        return;
      }
      if (data.length > 0) {
        hasDeferredOutputRef.current = true;
        deferredOutputRef.current = "";
        requiresSnapshotRestoreRef.current = true;
      }
      return;
    }

    renderTerminalSnapshot(data);
  }, [renderTerminalSnapshot]);

  const onOutput = useCallback((data: string) => {
    const nextChunk = filterBrowserHandledTerminalOutput(data);
    if (!nextChunk) {
      return;
    }
    websocketContentVersionRef.current += 1;

    const now = Date.now();
    if (!activeRef.current && nextChunk.includes(BELL_CHARACTER)) {
      onBellRef.current?.();
    }

    if (
      containsTerminalActivityContent(nextChunk) &&
      shouldMarkTerminalActivity({
        active: activeRef.current,
        now,
        openedAt: openedAtRef.current,
        lastResizedAt: lastResizedAtRef.current,
      }) &&
      shouldEmitTerminalActivityPulse({
        now,
        lastMarkedAt: lastActivityMarkedAtRef.current,
      })
    ) {
      lastActivityMarkedAtRef.current = now;
      onActivityRef.current?.();
    }

    outputSequenceRef.current += 1;
    const outputSequence = outputSequenceRef.current;
    logTerminalPerf("terminal.output.received", {
      terminalSessionId,
      seq: outputSequence,
      sinceLastInputMs:
        lastInputSentAtRef.current === null
          ? null
          : now - lastInputSentAtRef.current,
      ...summarizeTerminalChunk(nextChunk),
    });
    recordTerminalPerfProbeEvent("terminal.output.received", nextChunk, {
      terminalSessionId,
      seq: outputSequence,
      sinceLastInputMs:
        lastInputSentAtRef.current === null
          ? null
          : now - lastInputSentAtRef.current,
      ...summarizeTerminalChunk(nextChunk),
    });

    const terminal = terminalRef.current;
    if (!activeRef.current) {
      if (
        terminal &&
        hasRenderedSnapshotRef.current &&
        !hasDeferredOutputRef.current &&
        !requiresSnapshotRestoreRef.current
      ) {
        const renderStartedAt = performance.now();
        terminal.write(nextChunk, () => {
          logTerminalPerf("terminal.background-output.rendered", {
            terminalSessionId,
            seq: outputSequence,
            renderDurationMs: Number(
              (performance.now() - renderStartedAt).toFixed(2),
            ),
            ...summarizeTerminalChunk(nextChunk),
          });
        });
        return;
      }
      markDeferredOutput(nextChunk);
      return;
    }

    if (!terminal) {
      return;
    }

    const renderStartedAt = performance.now();
    terminal.write(nextChunk, () => {
      const renderedAt = performance.now();
      const sinceLastInputMs =
        lastInputSentAtRef.current === null
          ? null
          : Date.now() - lastInputSentAtRef.current;
      logTerminalPerf("terminal.output.rendered", {
        terminalSessionId,
        seq: outputSequence,
        sinceLastInputMs,
        renderDurationMs: Number((renderedAt - renderStartedAt).toFixed(2)),
        ...summarizeTerminalChunk(nextChunk),
      });
      recordTerminalPerfProbeEvent("terminal.output.rendered", nextChunk, {
        terminalSessionId,
        seq: outputSequence,
        sinceLastInputMs,
        renderDurationMs: Number((renderedAt - renderStartedAt).toFixed(2)),
        ...summarizeTerminalChunk(nextChunk),
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const paintDelayMs = Number((performance.now() - renderedAt).toFixed(2));
          const paintedSinceLastInputMs =
            lastInputSentAtRef.current === null
              ? null
              : Date.now() - lastInputSentAtRef.current;
          recordTerminalPerfProbeEvent("terminal.output.painted", nextChunk, {
            terminalSessionId,
            seq: outputSequence,
            sinceLastInputMs: paintedSinceLastInputMs,
            paintDelayMs,
            ...summarizeTerminalChunk(nextChunk),
          });
        });
      });
    });
  }, [markDeferredOutput, terminalSessionId]);

  const { error, sendInput, sendResize, runtimeKind } = useTerminalConnection({
    apiBase,
    terminalSessionId,
    token,
    onAuthExpired,
    onSnapshot,
    onOutput,
    onMetadata,
  });

  const sendTerminalInput = useCallback(
    (data: string): void => {
      inputSequenceRef.current += 1;
      lastInputSentAtRef.current = Date.now();
      logTerminalPerf("terminal.input.captured", {
        terminalSessionId,
        seq: inputSequenceRef.current,
        ...summarizeTerminalChunk(data),
      });
      sendInput(data);
    },
    [sendInput, terminalSessionId],
  );

  const clearSearch = useCallback(() => {
    setSearchResults(null);
    searchAddonRef.current?.clearDecorations();
    searchAddonRef.current?.clearActiveDecoration();
  }, []);

  const updatePreferences = useCallback(
    (updates: Partial<TerminalPreferences>) => {
      setPreferences(saveTerminalPreferences(apiBase, updates));
    },
    [apiBase],
  );

  const runSearch = useCallback(
    (direction: "next" | "previous", query = searchQuery) => {
      if (!query) {
        clearSearch();
        return;
      }

      const searchAddon = searchAddonRef.current;
      if (!searchAddon) {
        return;
      }

      if (direction === "previous") {
        searchAddon.findPrevious(query, searchOptions);
        return;
      }

      searchAddon.findNext(query, searchOptions);
    },
    [clearSearch, searchOptions, searchQuery],
  );

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);

  useEffect(() => {
    onBellRef.current = onBell;
  }, [onBell]);

  useEffect(() => {
    onAuthExpiredRef.current = onAuthExpired;
  }, [onAuthExpired]);

  useEffect(() => {
    openTerminalLinkRef.current = (uri: string): void => {
      if (window.electronAPI?.isElectron !== true) {
        window.open(uri, "_blank", "noopener,noreferrer");
        return;
      }

      const nextUrl = normalizeTerminalBrowserUrl(uri);
      if (!nextUrl.ok) {
        return;
      }
      createBrowserTab(nextUrl.url);
      openBrowser();
    };
  }, [createBrowserTab, openBrowser]);

  useEffect(() => {
    onMetadataRef.current = onMetadata;
  }, [onMetadata]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    runtimeKindRef.current = runtimeKind;
  }, [runtimeKind]);

  useEffect(() => {
    setPreferences(loadTerminalPreferences(apiBase));
  }, [apiBase]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) {
      return;
    }

    const initialPreferences = preferencesRef.current;
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

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicode11Addon);
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
        if (!shouldThrottleTmuxScroll()) {
          const input = buildTmuxScrollInput(
            event.deltaY,
            terminal.cols,
            terminal.rows,
          );
          if (input) {
            sendTerminalInput(input);
          }
        }
      }

      event.preventDefault();
      event.stopPropagation();
      return false;
    });

    let rendererAddon: { dispose(): void } | null = null;
    const applyRendererPreference = (preference: TerminalRendererPreference) => {
      rendererAddon?.dispose();
      rendererAddon = null;

      const loadCanvas = (): boolean => {
        try {
          const canvas = new CanvasAddon();
          terminal.loadAddon(canvas);
          rendererAddon = canvas;
          setEffectiveRenderer("canvas");
          return true;
        } catch {
          setEffectiveRenderer("dom");
          return false;
        }
      };

      const loadWebgl = (allowCanvasFallback: boolean): boolean => {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            webgl.dispose();
            if (allowCanvasFallback) {
              if (!loadCanvas()) {
                setEffectiveRenderer("dom");
              }
              return;
            }
            setEffectiveRenderer("dom");
          });
          terminal.loadAddon(webgl);
          rendererAddon = webgl;
          setEffectiveRenderer("webgl");
          return true;
        } catch {
          if (allowCanvasFallback) {
            return loadCanvas();
          }
          return loadCanvas();
        }
      };

      if (preference === "dom") {
        setEffectiveRenderer("dom");
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

      if (!loadWebgl(true)) {
        setEffectiveRenderer("dom");
      }
    };
    applyRendererPreferenceRef.current = applyRendererPreference;
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
      lastSentResizeRef.current = { cols: dimensions.cols, rows: dimensions.rows };
      sendResize(dimensions.cols, dimensions.rows);
    };
    const resizeScheduler = createResizeScheduler(
      syncSize,
      TERMINAL_RESIZE_DEBOUNCE_MS,
    );
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (!preferencesRef.current.copyOnSelect) {
        return;
      }

      const selection = terminal.getSelection();
      if (!selection || !navigator.clipboard?.writeText) {
        return;
      }

      void navigator.clipboard.writeText(selection).catch(() => undefined);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (isShiftEnterLineFeed(event)) {
        event.preventDefault();
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
      sendTerminalInput(data);
    });
    const bellDisposable = terminal.onBell(() => {
      if (!activeRef.current) {
        onBellRef.current?.();
      }
      if (preferencesRef.current.bellMode === "sound") {
        bellPlayerRef.current.play();
      }
    });

    syncSize();

    let mountFitFrameId: number | null = null;
    mountFitFrameId = requestAnimationFrame(() => {
      mountFitFrameId = null;
      syncSize();
    });
    const searchResultsDisposable = searchAddon.onDidChangeResults((results) => {
      setSearchResults(
        results
          ? {
              resultCount: results.resultCount,
              resultIndex: results.resultIndex,
            }
          : null,
      );
    });

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
    helperTextarea?.addEventListener("paste", handlePasteEvent, true);
    helperTextarea?.addEventListener("beforeinput", handleMobileBeforeInput, true);

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
        "beforeinput",
        handleMobileBeforeInput,
        true,
      );
      searchResultsDisposable.dispose();
      dataDisposable.dispose();
      bellDisposable.dispose();
      selectionDisposable.dispose();
      resizeScheduler.dispose();
      rendererAddon?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      refreshTerminalViewportRef.current = null;
      searchAddonRef.current = null;
      applyRendererPreferenceRef.current = null;
    };
  }, [
    apiBase,
    clientMode,
    onAuthExpired,
    sendTerminalInput,
    sendResize,
    terminalSessionId,
  ]);

  useEffect(() => {
    let cancelled = false;

    void getTerminalSession(apiBase, token, terminalSessionId)
      .then((session) => {
        if (cancelled) {
          return;
        }
        onMetadataRef.current?.({
          cwd: session.cwd,
          activeCommand: session.activeCommand,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpiredRef.current?.();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, terminalSessionId, token]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.fontFamily = preferences.fontFamily;
    terminal.options.fontSize = preferences.fontSize;
    terminal.options.cursorBlink = preferences.cursorBlink;
    terminal.options.screenReaderMode = preferences.screenReaderMode;
    applyRendererPreferenceRef.current?.(preferences.renderer);
    refreshTerminalViewportRef.current?.();
  }, [preferences]);

  useEffect(() => {
    if (!active || !terminalRef.current) {
      return;
    }

    return scheduleTerminalViewportRefresh(() => {
      if (!activeRef.current || !terminalRef.current) {
        return;
      }

      terminalRef.current.focus();
      refreshTerminalViewportRef.current?.();
    }, { delayMs: TERMINAL_RESIZE_DEBOUNCE_MS });
  }, [active, layoutVersion]);

  useEffect(() => {
    if (!active || !terminalRef.current) {
      return;
    }

    let cancelled = false;
    const requestId = restoreSnapshotRequestRef.current + 1;
    restoreSnapshotRequestRef.current = requestId;

    if (
      hasRenderedSnapshotRef.current &&
      !hasDeferredOutputRef.current &&
      !requiresSnapshotRestoreRef.current
    ) {
      return () => {
        cancelled = true;
      };
    }

    if (hasRenderedSnapshotRef.current && !requiresSnapshotRestoreRef.current) {
      if (replayDeferredOutput()) {
        return () => {
          cancelled = true;
        };
      }
      hasDeferredOutputRef.current = false;
      return () => {
        cancelled = true;
      };
    }

    const restoreSnapshot = async (attempt: number): Promise<void> => {
      const websocketContentVersionAtRequest = websocketContentVersionRef.current;
      try {
        const session = await getTerminalSession(
          apiBase,
          tokenRef.current,
          terminalSessionId,
        );
        if (
          cancelled ||
          restoreSnapshotRequestRef.current !== requestId
        ) {
          return;
        }

        if (websocketContentVersionRef.current !== websocketContentVersionAtRequest) {
          if (requiresSnapshotRestoreRef.current && attempt < 2) {
            await restoreSnapshot(attempt + 1);
            return;
          }
          if (!requiresSnapshotRestoreRef.current) {
            return;
          }
        }

        onMetadataRef.current?.({
          cwd: session.cwd,
          activeCommand: session.activeCommand,
        });
        renderTerminalSnapshot(session.scrollback);
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        hasDeferredOutputRef.current = true;
        requiresSnapshotRestoreRef.current = true;
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpiredRef.current?.();
        }
      }
    };

    void restoreSnapshot(0);

    return () => {
      cancelled = true;
    };
  }, [
    active,
    apiBase,
    renderTerminalSnapshot,
    replayDeferredOutput,
    terminalSessionId,
  ]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) {
      clearSearch();
      return;
    }

    runSearch("next");
  }, [clearSearch, runSearch, searchOpen, searchOptions, searchQuery]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (clientMode === "mobile") {
        return;
      }

      const openSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
      if (openSearch) {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        terminalRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, clientMode, searchOpen]);

  useEffect(() => {
    if (clientMode !== "mobile") {
      return;
    }

    setSearchOpen(false);
    setSettingsMenuOpen(false);
  }, [clientMode]);

  useEffect(() => {
    if (active && clientMode === "mobile") {
      return;
    }

    setMobileKeybarOpen(false);
  }, [active, clientMode]);

  const showTerminalToolbar = active && clientMode !== "mobile";
  const showMobileKeybarToggle = active && clientMode === "mobile";

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
        {showTerminalToolbar ? (
          <div className="pointer-events-none absolute top-3 right-4 z-10 flex items-start gap-2">
            {searchOpen ? (
              <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/95 px-2 py-2 shadow-[0_18px_44px_-30px_rgba(15,23,42,0.9)] backdrop-blur">
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      runSearch(event.shiftKey ? "previous" : "next");
                    }
                  }}
                  className="w-44 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 outline-none placeholder:text-slate-500"
                  placeholder="Find in terminal"
                />
                <span className="min-w-16 text-center text-[11px] text-slate-400">
                  {searchResults?.resultCount
                    ? `${searchResults.resultIndex + 1}/${searchResults.resultCount}`
                    : searchQuery
                      ? "0/0"
                      : "--"}
                </span>
                <button
                  type="button"
                  className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:border-slate-500"
                  onClick={() => {
                    runSearch("previous");
                  }}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:border-slate-500"
                  onClick={() => {
                    runSearch("next");
                  }}
                >
                  Next
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    searchOptions.caseSensitive
                      ? "border-slate-100 bg-slate-100 text-slate-950"
                      : "border-slate-700 text-slate-300"
                  }`}
                  onClick={() => {
                    setSearchOptions((current) => ({
                      ...current,
                      caseSensitive: !current.caseSensitive,
                    }));
                  }}
                >
                  Aa
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    searchOptions.wholeWord
                      ? "border-slate-100 bg-slate-100 text-slate-950"
                      : "border-slate-700 text-slate-300"
                  }`}
                  onClick={() => {
                    setSearchOptions((current) => ({
                      ...current,
                      wholeWord: !current.wholeWord,
                    }));
                  }}
                >
                  Word
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    searchOptions.regex
                      ? "border-slate-100 bg-slate-100 text-slate-950"
                      : "border-slate-700 text-slate-300"
                  }`}
                  onClick={() => {
                    setSearchOptions((current) => ({
                      ...current,
                      regex: !current.regex,
                    }));
                  }}
                >
                  .*
                </button>
                <button
                  type="button"
                  className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-slate-500"
                  onClick={() => {
                    setSearchOpen(false);
                    terminalRef.current?.focus();
                  }}
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                <DropdownMenu
                  open={settingsMenuOpen}
                  onOpenChange={setSettingsMenuOpen}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/90 px-3 py-1.5 text-[11px] text-slate-300 backdrop-blur hover:border-slate-500"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      Terminal
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 overflow-y-auto overscroll-contain"
                  >
                    <DropdownMenuLabel>Terminal Settings</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[11px] text-slate-500">
                      Font Size {preferences.fontSize}px
                    </DropdownMenuLabel>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <button
                        type="button"
                        className="flex-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-slate-500"
                        onClick={() => {
                          updatePreferences({
                            fontSize: clampTerminalFontSize(preferences.fontSize - 1),
                          });
                        }}
                      >
                        Smaller
                      </button>
                      <button
                        type="button"
                        className="flex-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-slate-500"
                        onClick={() => {
                          updatePreferences({
                            fontSize: clampTerminalFontSize(preferences.fontSize + 1),
                          });
                        }}
                      >
                        Larger
                      </button>
                    </div>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[11px] text-slate-500">
                      Font Family
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={preferences.fontFamily}
                      onValueChange={(value) => {
                        updatePreferences({
                          fontFamily: value as TerminalPreferences["fontFamily"],
                        });
                      }}
                    >
                      <DropdownMenuRadioItem value={DEFAULT_TERMINAL_PREFERENCES.fontFamily}>
                        Fira Code
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value={'"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace'}>
                        JetBrains Mono
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value={'"SFMono-Regular", ui-monospace, monospace'}>
                        SF Mono
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[11px] text-slate-500">
                      Renderer {effectiveRenderer.toUpperCase()}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={preferences.renderer}
                      onValueChange={(value) => {
                        updatePreferences({
                          renderer: value as TerminalRendererPreference,
                        });
                      }}
                    >
                      <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="webgl">WebGL</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="canvas">Canvas</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dom">DOM</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      checked={preferences.bellMode === "sound"}
                      onCheckedChange={(checked) => {
                        updatePreferences({
                          bellMode: checked === true ? "sound" : "off",
                        });
                        if (checked === true) {
                          void bellPlayerRef.current.play();
                        }
                      }}
                    >
                      Bell Sound
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={preferences.cursorBlink}
                      onCheckedChange={(checked) => {
                        updatePreferences({ cursorBlink: checked === true });
                      }}
                    >
                      Cursor Blink
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={preferences.copyOnSelect}
                      onCheckedChange={(checked) => {
                        updatePreferences({ copyOnSelect: checked === true });
                      }}
                    >
                      Copy On Select
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={preferences.screenReaderMode}
                      onCheckedChange={(checked) => {
                        updatePreferences({ screenReaderMode: checked === true });
                      }}
                    >
                      Screen Reader Mode
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        setSettingsMenuOpen(false);
                        requestAnimationFrame(() => {
                          onOpenHistory?.();
                        });
                      }}
                    >
                      View History
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  className="pointer-events-auto rounded-full border border-slate-700 bg-slate-950/90 px-3 py-1.5 text-[11px] text-slate-300 backdrop-blur hover:border-slate-500"
                  onClick={() => {
                    setSearchOpen(true);
                  }}
                >
                  Find
                </button>
              </>
            )}
          </div>
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
                setMobileKeybarOpen((current) => !current);
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
        <TerminalMobileKeybar
          visible={active && clientMode === "mobile" && mobileKeybarOpen}
          onSendInput={sendTerminalInput}
        />
      </div>
    </div>
  );
}
