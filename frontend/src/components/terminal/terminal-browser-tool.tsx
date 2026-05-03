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
  normalizeTerminalBrowserHeaderRules,
  type TerminalBrowserDevicePresetId,
  type TerminalBrowserHeaderRule,
  type TerminalBrowserProxyState,
} from "@browser-viewer/shared";
import { aiDiagnosticLog } from "../../features/diagnostic-logs/recorder";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { TerminalBrowserErrorBanners } from "./terminal-browser-error-banners";
import {
  buildTabStateFromElectronSnapshot,
  buildTabUpdateFromElectronSnapshot,
  buildTabUpdateFromElectronUpdate,
  type ElectronBrowserSnapshot,
  type ElectronBrowserUpdate,
  isNavigationAbortError,
  openUrlExternally,
} from "./terminal-browser-model";
import { TerminalBrowserNavigationBar } from "./terminal-browser-navigation-bar";
import { TerminalBrowserSurface } from "./terminal-browser-surface";
import { TerminalBrowserTabs } from "./terminal-browser-tabs";

interface TerminalBrowserToolProps {
  active: boolean;
}
const HEADER_RULES_STORAGE_KEY = "terminal.browser.headerRules";
const TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX = 320;

export function TerminalBrowserTool({ active }: TerminalBrowserToolProps) {
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
  const frameRef = useRef<number | null>(null);
  const loadedUrlByTabRef = useRef<Record<string, string>>({});
  const navigationSequenceByTabRef = useRef<Record<string, number>>({});
  const deviceViewportByTabRef = useRef<
    Record<string, { mobile: boolean; width: number } | undefined>
  >({});
  const deviceInfoByTabRef = useRef<
    | Record<
        string,
        {
          presetId: string;
          logicalWidth: number | null;
          logicalHeight: number | null;
        }
      >
    | undefined
  >({});
  const lastBoundsKeyByTabRef = useRef<Record<string, string>>({});
  const activeTabIdRef = useRef(activeTabId);
  const activeRef = useRef(active);
  const isElectron = window.electronAPI?.isElectron === true;
  const [proxyState, setProxyState] =
    useState<TerminalBrowserProxyState | null>(null);
  const [proxySwitching, setProxySwitching] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [headerRules, setHeaderRules] = useState<TerminalBrowserHeaderRule[]>(
    [],
  );
  const [electronTabsSynced, setElectronTabsSynced] = useState(!isElectron);
  const [deviceSwitching, setDeviceSwitching] = useState(false);
  const [headerSaving, setHeaderSaving] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [headerRulesPanelOpen, setHeaderRulesPanelOpen] = useState(false);
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
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
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    const nextViewports: Record<
      string,
      { mobile: boolean; width: number } | undefined
    > = {};
    for (const tab of tabs) {
      nextViewports[tab.id] =
        tab.deviceState.mobile && tab.deviceState.viewport
          ? { mobile: true, width: tab.deviceState.viewport.width }
          : { mobile: false, width: 1 };
    }
    deviceViewportByTabRef.current = nextViewports;
    deviceInfoByTabRef.current = Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        {
          presetId: tab.deviceState.presetId,
          logicalWidth: tab.deviceState.viewport?.width ?? null,
          logicalHeight: tab.deviceState.viewport?.height ?? null,
        },
      ]),
    );
  }, [tabs]);
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
  const syncBoundsForTab = useCallback(
    (tabId: string, immediate = false) => {
      if (!isElectron) {
        return;
      }

      const sendBounds = (): void => {
        frameRef.current = null;
        if (!activeRef.current) {
          void window.electronAPI?.terminalBrowserHide?.(tabId);
          delete lastBoundsKeyByTabRef.current[tabId];
          return;
        }
        const rect = browserViewRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          return;
        }
        const containerRect = surfaceContainerRef.current?.getBoundingClientRect();
        const sidePanelOpen = headerRulesPanelOpen || devicePanelOpen;
        const rawBounds = {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        const maxRight =
          containerRect && sidePanelOpen
            ? Math.round(containerRect.right - TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX)
            : null;
        const clippedWidth =
          maxRight === null
            ? rawBounds.width
            : Math.max(0, Math.min(rawBounds.x + rawBounds.width, maxRight) - rawBounds.x);
        if (clippedWidth <= 0) {
          return;
        }
        const viewport = deviceViewportByTabRef.current[tabId];
        const emulationScale =
          viewport?.mobile && viewport.width > 0
            ? clippedWidth / viewport.width
            : 1;
        void window.electronAPI?.terminalBrowserShow?.(tabId);
        const nextBounds = {
          x: rawBounds.x,
          y: rawBounds.y,
          width: clippedWidth,
          height: rawBounds.height,
          emulationScale,
        };
        const boundsKey = [
          nextBounds.x,
          nextBounds.y,
          nextBounds.width,
          nextBounds.height,
          nextBounds.emulationScale.toFixed(4),
        ].join(":");
        if (lastBoundsKeyByTabRef.current[tabId] === boundsKey) {
          const deviceInfo = deviceInfoByTabRef.current?.[tabId];
          aiDiagnosticLog("terminal browser bounds sync skipped", {
            tabId,
            boundsKey,
            presetId: deviceInfo?.presetId ?? null,
          });
          return;
        }
        lastBoundsKeyByTabRef.current[tabId] = boundsKey;
        const deviceInfo = deviceInfoByTabRef.current?.[tabId];
        aiDiagnosticLog("terminal browser bounds syncing", {
          tabId,
          presetId: deviceInfo?.presetId ?? null,
          logicalWidth: deviceInfo?.logicalWidth ?? null,
          logicalHeight: deviceInfo?.logicalHeight ?? null,
          x: nextBounds.x,
          y: nextBounds.y,
          width: nextBounds.width,
          height: nextBounds.height,
          emulationScale,
          rawWidth: rawBounds.width,
          clippedBySidePanel: clippedWidth !== rawBounds.width,
        });
        const boundsPromise = window.electronAPI?.terminalBrowserSetBounds?.(
          tabId,
          nextBounds,
        );
        void boundsPromise?.catch((error) => {
          updateBrowserTab(tabId, {
            error:
              error instanceof Error
                ? error.message
                : "Failed to sync browser bounds",
          });
        });
      };

      if (immediate) {
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        sendBounds();
        return;
      }

      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(sendBounds);
      }
    },
    [devicePanelOpen, headerRulesPanelOpen, isElectron, updateBrowserTab],
  );

  const syncBounds = useCallback(
    (immediate = false) => {
      if (!activeTabId) {
        return;
      }
      syncBoundsForTab(activeTabId, immediate);
    },
    [activeTabId, syncBoundsForTab],
  );

  const syncActiveTabBounds = useCallback(
    (tabId: string) => {
      if (activeTabIdRef.current === tabId) {
        syncBoundsForTab(tabId, true);
      }
    },
    [syncBoundsForTab],
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
      delete lastBoundsKeyByTabRef.current[activeTabId];
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
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [active, activeTabId, isElectron, syncBounds]);

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
    let cancelled = false;
    const loadHeaderRules = async (): Promise<void> => {
      try {
        const rawRules = window.localStorage.getItem(HEADER_RULES_STORAGE_KEY);
        const persistedRules = rawRules
          ? normalizeTerminalBrowserHeaderRules(JSON.parse(rawRules))
          : [];
        if (cancelled) {
          return;
        }
        setHeaderRules(persistedRules);
        if (!window.electronAPI?.terminalBrowserSetHeaderRules) {
          throw new Error("Header rules are unavailable");
        }
        const state =
          await window.electronAPI.terminalBrowserSetHeaderRules(
            persistedRules,
          );
        if (!cancelled && state) {
          setHeaderRules(state.rules);
          setHeaderError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setHeaderRules([]);
          setHeaderError(
            error instanceof Error
              ? error.message
              : "Failed to load header rules",
          );
        }
      }
    };
    void loadHeaderRules();
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
      delete deviceViewportByTabRef.current[tabId];
      delete lastBoundsKeyByTabRef.current[tabId];
      closeBrowserTab(tabId);
    });
  }, [isElectron, closeBrowserTab]);

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

  const saveHeaderRules = async (
    nextRules: TerminalBrowserHeaderRule[],
  ): Promise<boolean> => {
    if (!isElectron) {
      return false;
    }
    setHeaderSaving(true);
    setHeaderError(null);
    try {
      const normalizedRules = normalizeTerminalBrowserHeaderRules(nextRules);
      if (!window.electronAPI?.terminalBrowserSetHeaderRules) {
        throw new Error("Header rules are unavailable");
      }
      const previousRules = window.localStorage.getItem(
        HEADER_RULES_STORAGE_KEY,
      );
      window.localStorage.setItem(
        HEADER_RULES_STORAGE_KEY,
        JSON.stringify(normalizedRules),
      );
      let state;
      try {
        state =
          await window.electronAPI.terminalBrowserSetHeaderRules(
            normalizedRules,
          );
      } catch (error) {
        if (previousRules === null) {
          window.localStorage.removeItem(HEADER_RULES_STORAGE_KEY);
        } else {
          window.localStorage.setItem(HEADER_RULES_STORAGE_KEY, previousRules);
        }
        throw error;
      }
      setHeaderRules(state.rules);
      return true;
    } catch (error) {
      setHeaderError(
        error instanceof Error ? error.message : "Failed to save header rules",
      );
      return false;
    } finally {
      setHeaderSaving(false);
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
          error instanceof Error ? error.message : "Failed to switch device mode",
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <TerminalBrowserTabs
        tabs={tabs}
        activeTabId={activeTab.id}
        onCreateTab={() => createBrowserTab()}
        onSelectTab={setActiveBrowserTab}
        onCloseTab={closeTab}
      />
      <TerminalBrowserNavigationBar
        activeTab={activeTab}
        isElectron={isElectron}
        proxyState={proxyState}
        proxySwitching={proxySwitching}
        headerRulesPanelOpen={headerRulesPanelOpen}
        headerRules={headerRules}
        devicePanelOpen={devicePanelOpen}
        deviceSwitching={deviceSwitching}
        onSubmitAddress={submitAddress}
        onAddressInputChange={(addressInput) =>
          updateBrowserTab(activeTab.id, { addressInput })
        }
        onGo={(direction) => void go(direction)}
        onReload={() => void reload()}
        onStop={stop}
        onToggleProxy={() => void toggleProxy()}
        onDevicePanelOpenChange={setDevicePanelOpenState}
        onHeaderRulesPanelOpenChange={setHeaderPanelOpen}
        onOpenDevTools={() => {
          void window.electronAPI?.terminalBrowserOpenDevTools?.(activeTab.id);
        }}
        onOpenExternal={() => openUrlExternally(activeTab.url)}
      />
      <TerminalBrowserErrorBanners
        errors={[proxyError, headerError, activeTab.error]}
      />
      <TerminalBrowserSurface
        containerRef={surfaceContainerRef}
        browserViewRef={browserViewRef}
        isElectron={isElectron}
        headerRulesPanelOpen={headerRulesPanelOpen}
        headerRules={headerRules}
        devicePanelOpen={devicePanelOpen}
        deviceState={activeTab.deviceState}
        deviceSwitching={deviceSwitching}
        mobileDisabledReason={mobileDisabledReason}
        headerSaving={headerSaving}
        headerError={headerError}
        onCloseHeaderRulesPanel={() => setHeaderPanelOpen(false)}
        onCloseDevicePanel={() => setDevicePanelOpenState(false)}
        onSelectDevicePreset={(presetId) => void selectDevicePreset(presetId)}
        onSaveHeaderRules={saveHeaderRules}
        onReload={() => void reload()}
        onOpenExternal={() => openUrlExternally(activeTab.url)}
      />
    </div>
  );
}
