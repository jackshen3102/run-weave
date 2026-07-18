import { useMemoizedFn } from "ahooks";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalBrowserBounds } from "./use-terminal-browser-bounds";
import { useTerminalBrowserDeviceSelection } from "./use-terminal-browser-device-selection";
import { useTerminalBrowserHeaderRules } from "./use-terminal-browser-header-rules";
import { useTerminalBrowserAnnotations } from "./use-terminal-browser-annotations";
import { useTerminalBrowserProxy } from "./use-terminal-browser-proxy";
import { useTerminalBrowserDisplayScale } from "./use-terminal-browser-display-scale";
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
  const setDisplayScale = useTerminalBrowserDisplayScale(
    activeTabId,
    isElectron,
  );
  const [electronTabsSynced, setElectronTabsSynced] = useState(!isElectron);
  const [headerRulesPanelOpen, setHeaderRulesPanelOpen] = useState(false);
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
  const editingAddressTabIdRef = useRef<string | null>(null);
  const { headerError, headerRules, headerSaving, saveHeaderRules } =
    useTerminalBrowserHeaderRules(isElectron);
  const {
    error: proxyError,
    state: proxyState,
    switching: proxySwitching,
    toggle: toggleProxy,
  } = useTerminalBrowserProxy(isElectron);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );
  const { deviceSwitching, selectDevicePreset } =
    useTerminalBrowserDeviceSelection({
      activeTab,
      isElectron,
      updateBrowserTab,
    });
  const {
    closePanel: closeAnnotationPanel,
    deleteAnnotation,
    error: annotationError,
    focusAnnotation,
    handleTabClosed: handleAnnotationTabClosed,
    openPanel: openAnnotationPanelState,
    panelOpen: annotationPanelOpen,
    setSelecting: setAnnotationSelecting,
    state: annotationState,
    stop: discardAnnotations,
    submit: submitAnnotations,
    submitting: annotationSubmitting,
    toggle: toggleAnnotations,
  } = useTerminalBrowserAnnotations({
    activeTabId: activeTab?.id ?? null,
    apiBase,
    isElectron,
    terminalSessionId,
    token,
  });
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
    annotationPanelOpen,
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
      const tabUpdate = buildTabUpdateFromElectronUpdate(update);
      if (editingAddressTabIdRef.current === tabId) {
        const { addressInput, ...updateWithoutAddressInput } = tabUpdate;
        void addressInput;
        updateBrowserTab(tabId, updateWithoutAddressInput);
        return;
      }
      updateBrowserTab(tabId, tabUpdate);
    },
  );

  const syncElectronTabs = useMemoizedFn(async (): Promise<void> => {
    try {
      const snapshots = await window.electronAPI?.terminalBrowserListTabs?.();
      if (!snapshots) {
        return;
      }
      if (snapshots.length > 0) {
        for (const snapshot of snapshots) {
          loadedUrlByTabRef.current[snapshot.tabId] = snapshot.url;
        }
        const activeSnapshot = snapshots.find((snapshot) => snapshot.active);
        replaceBrowserTabs(
          snapshots.map(buildTabStateFromElectronSnapshot),
          activeSnapshot?.tabId,
        );
        if (activeSnapshot && active) {
          await window.electronAPI?.terminalBrowserShow?.(activeSnapshot.tabId);
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
  }, [annotationPanelOpen, devicePanelOpen, headerRulesPanelOpen, syncBounds]);

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
    if (!isElectron || !electronTabsSynced || !activeTabId) {
      return;
    }
    if (!active) {
      void window.electronAPI?.terminalBrowserHide?.(activeTabId);
      clearTabBounds(activeTabId);
      return;
    }
    void window.electronAPI?.terminalBrowserShow?.(activeTabId);
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
    electronTabsSynced,
    isElectron,
    syncBounds,
  ]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    void syncElectronTabs();
    return window.electronAPI?.onTerminalBrowserTabCreatedFromProxy?.(
      ({ tabId, browserGroupId, url, title, openerTabId }) => {
        loadedUrlByTabRef.current[tabId] = url;
        addProxyBrowserTab(tabId, browserGroupId, url, title, openerTabId);
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
      handleAnnotationTabClosed(tabId);
    });
  }, [handleAnnotationTabClosed, isElectron, closeBrowserTab, clearTabBounds]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    return window.electronAPI?.onTerminalBrowserTabActivatedFromProxy?.(
      ({ tabId, ...update }) => {
        addProxyBrowserTab(
          tabId,
          update.browserGroupId,
          update.url,
          update.title,
        );
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

  const reorderTabs = useMemoizedFn(
    (fromIndex: number, toIndex: number): void => {
      const currentTabs = useTerminalPreviewStore.getState().browser.tabs;
      if (
        fromIndex < 0 ||
        fromIndex >= currentTabs.length ||
        toIndex < 0 ||
        toIndex >= currentTabs.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const nextTabs = [...currentTabs];
      const [movedTab] = nextTabs.splice(fromIndex, 1);
      if (!movedTab) {
        return;
      }
      nextTabs.splice(toIndex, 0, movedTab);
      reorderBrowserTabs(fromIndex, toIndex);
      if (!isElectron || !window.electronAPI?.terminalBrowserReorderTabs) {
        return;
      }
      void window.electronAPI
        .terminalBrowserReorderTabs(nextTabs.map((tab) => tab.id))
        .catch(() => {
          void syncElectronTabs().catch(() => undefined);
        });
    },
  );

  const toggleAnnotation = useMemoizedFn(async (): Promise<void> => {
    setHeaderRulesPanelOpen(false);
    setDevicePanelOpen(false);
    await toggleAnnotations();
  });

  const openAnnotationPanel = useMemoizedFn((): void => {
    setHeaderRulesPanelOpen(false);
    setDevicePanelOpen(false);
    openAnnotationPanelState();
  });

  if (!activeTab) {
    return null;
  }

  const submitAddress = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    editingAddressTabIdRef.current = null;
    void navigateTab(activeTab.id, activeTab.addressInput);
  };

  const handleAddressFocus = (): void => {
    editingAddressTabIdRef.current = activeTab.id;
  };

  const handleAddressBlur = (): void => {
    if (editingAddressTabIdRef.current === activeTab.id) {
      editingAddressTabIdRef.current = null;
    }
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
      void closeAnnotationPanel();
    }
  };

  const setDevicePanelOpenState = (open: boolean): void => {
    setDevicePanelOpen(open);
    if (open) {
      setHeaderRulesPanelOpen(false);
      void closeAnnotationPanel();
    }
  };

  const closeTab = (
    event: { stopPropagation: () => void },
    tabId: string,
  ): void => {
    event.stopPropagation();
    void window.electronAPI?.terminalBrowserCloseTab?.(tabId);
    delete loadedUrlByTabRef.current[tabId];
    delete navigationSequenceByTabRef.current[tabId];
    closeBrowserTab(tabId);
  };

  return {
    activeTab,
    annotationPanelOpen,
    annotationError,
    annotationState,
    annotationSubmitting,
    browserViewRef,
    closeTab,
    closeAnnotationPanel,
    createBrowserTab,
    deleteAnnotation,
    devicePanelOpen,
    deviceSwitching,
    go,
    headerError,
    headerRules,
    headerRulesPanelOpen,
    headerSaving,
    handleAddressBlur,
    handleAddressFocus,
    isElectron,
    mobileDisabledReason,
    openUrlExternally,
    openAnnotationPanel,
    proxyError,
    proxyState,
    proxySwitching,
    reload,
    reorderTabs,
    saveHeaderRules,
    selectDevicePreset,
    setDisplayScale,
    setActiveBrowserTab,
    setAnnotationSelecting,
    setDevicePanelOpenState,
    setHeaderPanelOpen,
    stop,
    discardAnnotations,
    submitAddress,
    submitAnnotations,
    surfaceContainerRef,
    tabs,
    toggleProxy,
    toggleAnnotation,
    focusAnnotation,
    updateBrowserTab,
  };
}
