import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type TerminalBrowserDevicePresetId,
  type TerminalBrowserProxyState,
} from "@browser-viewer/shared";
import { aiDiagnosticLog } from "../../features/diagnostic-logs/recorder";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalBrowserBounds } from "./use-terminal-browser-bounds";
import { useTerminalBrowserHeaderRules } from "./use-terminal-browser-header-rules";
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
}

export function useTerminalBrowserController({
  active,
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
  const { headerError, headerRules, headerSaving, saveHeaderRules } =
    useTerminalBrowserHeaderRules(isElectron);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );
  const activeTabUrl = activeTab?.url;
  const mobileDisabledReason = activeTab?.cdpProxyAttached
    ? "Mobile mode unavailable while CDP proxy is active"
    : activeTab?.devtoolsOpen
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
  const applyElectronSnapshot = useCallback(
    (tabId: string, snapshot: ElectronBrowserSnapshot) => {
      updateBrowserTab(tabId, buildTabUpdateFromElectronSnapshot(snapshot));
    },
    [updateBrowserTab],
  );
  const applyElectronUpdate = useCallback(
    (tabId: string, update: ElectronBrowserUpdate) => {
      updateBrowserTab(tabId, buildTabUpdateFromElectronUpdate(update));
    },
    [updateBrowserTab],
  );

  const syncElectronTabs = useCallback(async (): Promise<void> => {
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
  }, [replaceBrowserTabs, syncActiveTabBounds]);

  const navigateTab = useCallback(
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
    [applyElectronSnapshot, isElectron, syncActiveTabBounds, updateBrowserTab],
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
    saveHeaderRules,
    selectDevicePreset,
    setActiveBrowserTab,
    setDevicePanelOpenState,
    setHeaderPanelOpen,
    stop,
    submitAddress,
    surfaceContainerRef,
    tabs,
    toggleProxy,
    updateBrowserTab,
  };
}
