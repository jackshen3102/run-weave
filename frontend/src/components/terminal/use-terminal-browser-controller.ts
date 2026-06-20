import { useMemoizedFn } from "ahooks";
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type TerminalBrowserAnnotationState,
  type TerminalBrowserDevicePresetId,
  type TerminalBrowserProxyState,
} from "@runweave/shared";
import { aiDiagnosticLog } from "../../features/diagnostic-logs/recorder";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import {
  createTerminalSessionClipboardImage,
  sendTerminalInput,
} from "../../services/terminal";
import { useTerminalBrowserBounds } from "./use-terminal-browser-bounds";
import { useTerminalBrowserHeaderRules } from "./use-terminal-browser-header-rules";
import { buildBrowserAnnotationPrompt } from "./terminal-browser-annotation-prompt";
import {
  buildTabStateFromElectronSnapshot,
  buildTabUpdateFromElectronSnapshot,
  buildTabUpdateFromElectronUpdate,
  type ElectronBrowserSnapshot,
  type ElectronBrowserUpdate,
  isNavigationAbortError,
  openUrlExternally,
} from "./terminal-browser-model";

interface TerminalBrowserToolProps {
  active: boolean;
  apiBase: string;
  token: string;
  terminalSessionId: string | null;
}

export function useTerminalBrowserController({
  active,
  apiBase,
  token,
  terminalSessionId,
}: TerminalBrowserToolProps) {
  const tabs = useTerminalPreviewStore((state) => state.browser.tabs);
  const activeTabId = useTerminalPreviewStore(
    (state) => state.browser.activeTabId,
  );
  const createBrowserTab = useTerminalPreviewStore(
    (state) => state.createBrowserTab,
  );
  const closeBrowserTab = useTerminalPreviewStore(
    (state) => state.closeBrowserTab,
  );
  const addProxyBrowserTab = useTerminalPreviewStore(
    (state) => state.addProxyBrowserTab,
  );
  const replaceBrowserTabs = useTerminalPreviewStore(
    (state) => state.replaceBrowserTabs,
  );
  const setActiveBrowserTab = useTerminalPreviewStore(
    (state) => state.setActiveBrowserTab,
  );
  const reorderBrowserTabs = useTerminalPreviewStore(
    (state) => state.reorderBrowserTabs,
  );
  const updateBrowserTab = useTerminalPreviewStore(
    (state) => state.updateBrowserTab,
  );
  const surfaceContainerRef = useRef<HTMLDivElement | null>(null);
  const browserViewRef = useRef<HTMLDivElement | null>(null);
  const loadedUrlByTabRef = useRef<Record<string, string>>({});
  const navigationSequenceByTabRef = useRef<Record<string, number>>({});
  const isElectron = window.electronAPI?.isElectron === true;
  const [proxyState, setProxyState] =
    useState<TerminalBrowserProxyState | null>(null);
  const [proxySwitching, setProxySwitching] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [electronTabsSynced, setElectronTabsSynced] = useState(!isElectron);
  const [deviceSwitching, setDeviceSwitching] = useState(false);
  const [headerRulesPanelOpen, setHeaderRulesPanelOpen] = useState(false);
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
  const [annotationTabId, setAnnotationTabIdState] = useState<string | null>(null);
  const annotationTabIdRef = useRef<string | null>(null);
  const handledAnnotationSubmitRequestRef = useRef<string | null>(null);
  const annotationSubmittingRef = useRef(false);
  const [annotationState, setAnnotationState] =
    useState<TerminalBrowserAnnotationState>({
      active: false,
      annotations: [],
    });
  const [annotationSubmitting, setAnnotationSubmitting] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const { headerError, headerRules, headerSaving, saveHeaderRules } =
    useTerminalBrowserHeaderRules(isElectron);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );
  const activeTabUrl = activeTab?.url;
  const mobileDisabledReason = activeTab?.devtoolsOpen
    ? "Mobile mode unavailable while DevTools is open"
    : null;
  const {
    cancelPendingBoundsSync,
    clearTabBounds,
    syncActiveTabBounds,
    syncBounds,
  } = useTerminalBrowserBounds({
    active,
    activeTabId,
    browserViewRef,
    devicePanelOpen,
    headerRulesPanelOpen,
    isElectron,
    surfaceContainerRef,
    tabs,
    updateBrowserTab,
  });
  const applyElectronSnapshot = useMemoizedFn(
    (tabId: string, snapshot: ElectronBrowserSnapshot) => {
      updateBrowserTab(tabId, buildTabUpdateFromElectronSnapshot(snapshot));
    },
  );
  const applyElectronUpdate = useMemoizedFn(
    (tabId: string, update: ElectronBrowserUpdate) => {
      updateBrowserTab(tabId, buildTabUpdateFromElectronUpdate(update));
    },
  );

  const setAnnotationTabId = (tabId: string | null): void => {
    annotationTabIdRef.current = tabId;
    setAnnotationTabIdState(tabId);
  };

  const submitAnnotationTab = useMemoizedFn(async (tabId: string): Promise<void> => {
    setAnnotationSubmitting(true);
    annotationSubmittingRef.current = true;
    setAnnotationError(null);
    try {
      if (!terminalSessionId) {
        setAnnotationError("Browser comments are ready, but no active terminal is available.");
        return;
      }
      const submission =
        await window.electronAPI?.terminalBrowserAnnotationSubmit?.(tabId);
      if (!submission || submission.annotations.length === 0) {
        setAnnotationError("No browser comments to submit.");
        return;
      }
      let screenshotPath: string | null = null;
      let submitWarning: string | null = null;
      if (submission.screenshot) {
        try {
          const savedScreenshot = await createTerminalSessionClipboardImage(
            apiBase,
            token,
            terminalSessionId,
            submission.screenshot,
          );
          screenshotPath = savedScreenshot.filePath;
        } catch (error) {
          submitWarning =
            error instanceof Error
              ? `Browser comments were submitted, but saving the marker screenshot failed: ${error.message}`
              : "Browser comments were submitted, but saving the marker screenshot failed.";
        }
      }
      const prompt = buildBrowserAnnotationPrompt(submission, {
        screenshotPath,
      });
      setAnnotationState({ active: false, annotations: [] });
      setAnnotationTabId(null);
      await sendTerminalInput(apiBase, token, terminalSessionId, {
        data: prompt,
        mode: "prompt_paste",
      });
      if (submitWarning) {
        setAnnotationError(submitWarning);
      }
    } catch (error) {
      setAnnotationError(
        error instanceof Error
          ? error.message
          : "Failed to submit browser comments",
      );
    } finally {
      handledAnnotationSubmitRequestRef.current = null;
      annotationSubmittingRef.current = false;
      setAnnotationSubmitting(false);
    }
  });

  const syncElectronTabs = useMemoizedFn(async (): Promise<void> => {
    try {
      const snapshots = await window.electronAPI?.terminalBrowserListTabs?.();
      if (!snapshots) {
        return;
      }
      const navigatedSnapshots = snapshots.filter((snapshot) => snapshot.url);
      if (navigatedSnapshots.length > 0) {
        for (const snapshot of navigatedSnapshots) {
          loadedUrlByTabRef.current[snapshot.tabId] = snapshot.url;
        }
        const activeSnapshot = navigatedSnapshots.find(
          (snapshot) => snapshot.active,
        );
        replaceBrowserTabs(
          navigatedSnapshots.map(buildTabStateFromElectronSnapshot),
          activeSnapshot?.tabId,
        );
        if (activeSnapshot) {
          syncActiveTabBounds(activeSnapshot.tabId);
        }
      }
    } finally {
      setElectronTabsSynced(true);
    }
  });

  const navigateTab = useMemoizedFn(
    async (tabId: string, rawInput: string): Promise<void> => {
      if (!tabId) {
        return;
      }
      const nextUrl = normalizeTerminalBrowserUrl(rawInput);
      if (!nextUrl.ok) {
        updateBrowserTab(tabId, {
          error: nextUrl.error,
          loading: false,
        });
        return;
      }

      updateBrowserTab(tabId, {
        url: nextUrl.url,
        addressInput: nextUrl.url,
        title: nextUrl.url.replace(/^https?:\/\//, ""),
        loading: true,
        error: undefined,
      });

      if (!isElectron || !window.electronAPI?.terminalBrowserNavigate) {
        updateBrowserTab(tabId, { loading: false });
        return;
      }

      syncActiveTabBounds(tabId);
      const navigationSequence =
        (navigationSequenceByTabRef.current[tabId] ?? 0) + 1;
      navigationSequenceByTabRef.current[tabId] = navigationSequence;
      const isCurrentNavigation = (): boolean =>
        navigationSequenceByTabRef.current[tabId] === navigationSequence;

      try {
        loadedUrlByTabRef.current[tabId] = nextUrl.url;
        const snapshot = await window.electronAPI.terminalBrowserNavigate(
          tabId,
          nextUrl.url,
        );
        if (!isCurrentNavigation()) {
          return;
        }
        applyElectronSnapshot(tabId, snapshot);
        syncActiveTabBounds(tabId);
      } catch (error) {
        if (!isCurrentNavigation()) {
          return;
        }
        if (isNavigationAbortError(error)) {
          updateBrowserTab(tabId, { error: undefined });
          syncActiveTabBounds(tabId);
          return;
        }
        updateBrowserTab(tabId, {
          loading: false,
          error: error instanceof Error ? error.message : "Navigation failed",
        });
        syncActiveTabBounds(tabId);
      }
    },
  );

  useEffect(() => {
    if (isElectron && !electronTabsSynced) {
      return;
    }
    if (!activeTabId || !activeTabUrl || !active || !isElectron) {
      syncBounds(true);
      return;
    }

    if (loadedUrlByTabRef.current[activeTabId] !== activeTabUrl) {
      void navigateTab(activeTabId, activeTabUrl);
      return;
    }

    syncBounds(true);
  }, [
    active,
    activeTabId,
    activeTabUrl,
    electronTabsSynced,
    isElectron,
    navigateTab,
    syncBounds,
  ]);

  useEffect(() => {
    syncBounds(true);
  }, [devicePanelOpen, headerRulesPanelOpen, syncBounds]);

  useEffect(() => {
    syncBounds(true);
  }, [activeTab?.deviceState, syncBounds]);

  useEffect(() => {
    if (!isElectron || !active || !activeTabId) {
      return;
    }
    let cancelled = false;
    const loadDeviceState = async (): Promise<void> => {
      try {
        const deviceState =
          await window.electronAPI?.terminalBrowserGetDeviceState?.(
            activeTabId,
          );
        if (!cancelled && deviceState) {
          updateBrowserTab(activeTabId, { deviceState, error: undefined });
        }
      } catch (error) {
        if (!cancelled) {
          updateBrowserTab(activeTabId, {
            error:
              error instanceof Error
                ? error.message
                : "Failed to load browser device state",
          });
        }
      }
    };
    void loadDeviceState();
    return () => {
      cancelled = true;
    };
  }, [active, activeTabId, isElectron, updateBrowserTab]);

  useEffect(() => {
    if (!isElectron || !activeTabId) {
      return;
    }
    if (!active) {
      void window.electronAPI?.terminalBrowserHide?.(activeTabId);
      clearTabBounds(activeTabId);
      return;
    }
    const element = surfaceContainerRef.current;
    if (!element) {
      return;
    }
    const handleWindowResize = (): void => syncBounds();
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(element);
    window.addEventListener("resize", handleWindowResize);
    syncBounds(true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      void window.electronAPI?.terminalBrowserHide?.(activeTabId);
      cancelPendingBoundsSync();
    };
  }, [
    active,
    activeTabId,
    cancelPendingBoundsSync,
    clearTabBounds,
    isElectron,
    syncBounds,
  ]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    let cancelled = false;
    const loadProxyState = async (): Promise<void> => {
      try {
        const state =
          await window.electronAPI?.terminalBrowserGetProxyState?.();
        if (!cancelled && state) {
          setProxyState(state);
          setProxyError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setProxyError(
            error instanceof Error
              ? error.message
              : "Failed to load proxy state",
          );
        }
      }
    };
    void loadProxyState();
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    void syncElectronTabs();
    return window.electronAPI?.onTerminalBrowserTabCreatedFromProxy?.(
      ({ tabId, url, title }) => {
        loadedUrlByTabRef.current[tabId] = url;
        addProxyBrowserTab(tabId, url, title);
      },
    );
  }, [isElectron, addProxyBrowserTab, syncElectronTabs]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    return window.electronAPI?.onTerminalBrowserTabUpdated?.(
      ({ tabId, ...update }) => {
        loadedUrlByTabRef.current[tabId] = update.url;
        applyElectronUpdate(tabId, update);
        syncActiveTabBounds(tabId);
      },
    );
  }, [isElectron, applyElectronUpdate, syncActiveTabBounds]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    return window.electronAPI?.onTerminalBrowserTabClosed?.(({ tabId }) => {
      delete loadedUrlByTabRef.current[tabId];
      delete navigationSequenceByTabRef.current[tabId];
      clearTabBounds(tabId);
      closeBrowserTab(tabId);
      if (annotationTabIdRef.current === tabId) {
        setAnnotationTabId(null);
        setAnnotationState({ active: false, annotations: [] });
      }
    });
  }, [isElectron, closeBrowserTab, clearTabBounds]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    return window.electronAPI?.onTerminalBrowserTabActivatedFromProxy?.(
      ({ tabId, ...update }) => {
        addProxyBrowserTab(tabId, update.url, update.title);
        loadedUrlByTabRef.current[tabId] = update.url;
        applyElectronUpdate(tabId, update);
        setActiveBrowserTab(tabId);
        syncActiveTabBounds(tabId);
      },
    );
  }, [
    isElectron,
    addProxyBrowserTab,
    applyElectronUpdate,
    setActiveBrowserTab,
    syncActiveTabBounds,
  ]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    return window.electronAPI?.onTerminalBrowserAnnotationUpdated?.(
      ({ tabId, state }) => {
        if (annotationTabIdRef.current === tabId || state.active) {
          setAnnotationTabId(state.active ? tabId : null);
          setAnnotationState(state);
        }
      },
    );
  }, [isElectron]);

  useEffect(() => {
    if (
      !isElectron ||
      !annotationState.active ||
      !annotationTabId ||
      !activeTabId ||
      annotationTabId === activeTabId
    ) {
      return;
    }
    let cancelled = false;
    void window.electronAPI
      ?.terminalBrowserAnnotationStop?.(annotationTabId)
      .then((state) => {
        if (cancelled) {
          return;
        }
        setAnnotationState(state ?? { active: false, annotations: [] });
        setAnnotationTabId(null);
        handledAnnotationSubmitRequestRef.current = null;
      })
      .catch((error) => {
        if (!cancelled) {
          setAnnotationError(
            error instanceof Error
              ? error.message
              : "Failed to stop browser comments",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTabId, annotationState.active, annotationTabId, isElectron]);

  useEffect(() => {
    if (!isElectron || !annotationState.active || !annotationTabId) {
      return;
    }
    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void window.electronAPI
        ?.terminalBrowserAnnotationList?.(annotationTabId)
        .then((state) => {
          if (cancelled) {
            return;
          }
          setAnnotationState(state);
          if (!state.active) {
            setAnnotationTabId(null);
            return;
          }
          const requestId = state.pendingSubmitRequestId;
          if (
            requestId &&
            handledAnnotationSubmitRequestRef.current !== requestId &&
            !annotationSubmittingRef.current
          ) {
            handledAnnotationSubmitRequestRef.current = requestId;
            void submitAnnotationTab(annotationTabId);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setAnnotationError(
              error instanceof Error
                ? error.message
                : "Failed to refresh browser comments",
            );
          }
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [annotationState.active, annotationTabId, isElectron, submitAnnotationTab]);

  if (!activeTab) {
    return null;
  }

  const submitAddress = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void navigateTab(activeTab.id, activeTab.addressInput);
  };

  const reload = async (): Promise<void> => {
    const tabId = activeTab.id;
    navigationSequenceByTabRef.current[tabId] =
      (navigationSequenceByTabRef.current[tabId] ?? 0) + 1;
    updateBrowserTab(tabId, { loading: true, error: undefined });
    try {
      const snapshot = await window.electronAPI?.terminalBrowserReload?.(tabId);
      if (snapshot) {
        applyElectronSnapshot(tabId, snapshot);
      } else {
        updateBrowserTab(tabId, { loading: false });
      }
    } catch (error) {
      updateBrowserTab(tabId, {
        loading: false,
        error: error instanceof Error ? error.message : "Reload failed",
      });
    }
  };

  const toggleProxy = async (): Promise<void> => {
    if (!isElectron || proxySwitching) {
      return;
    }
    const nextEnabled = !(proxyState?.enabled ?? false);
    setProxySwitching(true);
    setProxyError(null);
    try {
      const nextState =
        await window.electronAPI?.terminalBrowserSetProxyEnabled?.(nextEnabled);
      if (nextState) {
        setProxyState(nextState);
      }
    } catch (error) {
      setProxyError(
        error instanceof Error ? error.message : "Failed to switch proxy",
      );
    } finally {
      setProxySwitching(false);
    }
  };

  const go = async (direction: "back" | "forward"): Promise<void> => {
    try {
      const snapshot =
        direction === "back"
          ? await window.electronAPI?.terminalBrowserGoBack?.(activeTab.id)
          : await window.electronAPI?.terminalBrowserGoForward?.(activeTab.id);
      if (snapshot) {
        applyElectronSnapshot(activeTab.id, snapshot);
      }
    } catch {
      return;
    }
  };

  const stop = (): void => {
    navigationSequenceByTabRef.current[activeTab.id] =
      (navigationSequenceByTabRef.current[activeTab.id] ?? 0) + 1;
    updateBrowserTab(activeTab.id, { loading: false });
    void window.electronAPI?.terminalBrowserStop?.(activeTab.id);
  };

  const setHeaderPanelOpen = (open: boolean): void => {
    setHeaderRulesPanelOpen(open);
    if (open) {
      setDevicePanelOpen(false);
    }
  };

  const setDevicePanelOpenState = (open: boolean): void => {
    setDevicePanelOpen(open);
    if (open) {
      setHeaderRulesPanelOpen(false);
    }
  };

  const stopAnnotation = async (): Promise<void> => {
    const tabId = annotationTabId ?? activeTab.id;
    setAnnotationError(null);
    try {
      const state = await window.electronAPI?.terminalBrowserAnnotationStop?.(tabId);
      setAnnotationState(state ?? { active: false, annotations: [] });
      setAnnotationTabId(null);
      handledAnnotationSubmitRequestRef.current = null;
    } catch (error) {
      setAnnotationError(
        error instanceof Error ? error.message : "Failed to stop browser comments",
      );
    }
  };

  const toggleAnnotation = async (): Promise<void> => {
    if (!isElectron) {
      return;
    }
    if (annotationState.active) {
      await stopAnnotation();
      return;
    }
    setAnnotationError(null);
    handledAnnotationSubmitRequestRef.current = null;
    setHeaderRulesPanelOpen(false);
    setDevicePanelOpen(false);
    try {
      const state =
        await window.electronAPI?.terminalBrowserAnnotationStart?.(activeTab.id);
      setAnnotationTabId(activeTab.id);
      setAnnotationState(state ?? { active: true, annotations: [] });
    } catch (error) {
      setAnnotationError(
        error instanceof Error
          ? error.message
          : "Failed to start browser comments",
      );
    }
  };

  const submitAnnotations = async (): Promise<void> => {
    const tabId = annotationTabId ?? activeTab.id;
    await submitAnnotationTab(tabId);
  };

  const selectDevicePreset = async (
    presetId: TerminalBrowserDevicePresetId,
  ): Promise<void> => {
    if (!isElectron || deviceSwitching) {
      return;
    }
    setDeviceSwitching(true);
    updateBrowserTab(activeTab.id, { error: undefined });
    aiDiagnosticLog("terminal browser device preset selected", {
      tabId: activeTab.id,
      previousPresetId: activeTab.deviceState.presetId,
      nextPresetId: presetId,
      previousLogicalWidth: activeTab.deviceState.viewport?.width ?? null,
      previousLogicalHeight: activeTab.deviceState.viewport?.height ?? null,
    });
    try {
      const deviceState =
        await window.electronAPI?.terminalBrowserSetDeviceState?.(
          activeTab.id,
          presetId,
        );
      aiDiagnosticLog("terminal browser device preset applied", {
        tabId: activeTab.id,
        nextPresetId: presetId,
        returnedPresetId: deviceState?.presetId ?? null,
        returnedLogicalWidth: deviceState?.viewport?.width ?? null,
        returnedLogicalHeight: deviceState?.viewport?.height ?? null,
      });
      if (deviceState) {
        updateBrowserTab(activeTab.id, { deviceState, error: undefined });
      }
    } catch (error) {
      updateBrowserTab(activeTab.id, {
        error:
          error instanceof Error
            ? error.message
            : "Failed to switch device mode",
      });
    } finally {
      setDeviceSwitching(false);
    }
  };

  const closeTab = (event: ReactPointerEvent, tabId: string): void => {
    event.stopPropagation();
    void window.electronAPI?.terminalBrowserCloseTab?.(tabId);
    delete loadedUrlByTabRef.current[tabId];
    delete navigationSequenceByTabRef.current[tabId];
    closeBrowserTab(tabId);
  };

  return {
    activeTab,
    annotationError,
    annotationState,
    annotationSubmitting,
    browserViewRef,
    closeTab,
    createBrowserTab,
    devicePanelOpen,
    deviceSwitching,
    go,
    headerError,
    headerRules,
    headerRulesPanelOpen,
    headerSaving,
    isElectron,
    mobileDisabledReason,
    openUrlExternally,
    proxyError,
    proxyState,
    proxySwitching,
    reload,
    reorderBrowserTabs,
    saveHeaderRules,
    selectDevicePreset,
    setActiveBrowserTab,
    setDevicePanelOpenState,
    setHeaderPanelOpen,
    stop,
    submitAddress,
    submitAnnotations,
    surfaceContainerRef,
    tabs,
    toggleProxy,
    toggleAnnotation,
    updateBrowserTab,
  };
}
