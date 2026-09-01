import { useMemoizedFn } from "ahooks";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalBrowserWorkspaceSnapshot } from "@runweave/shared/terminal-browser-workspace";
import { normalizeTerminalBrowserUrl } from "../../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../../features/terminal/preview-store";
import { useTerminalBrowserDeviceSelection } from "./use-device-selection";
import { useTerminalBrowserHeaderRules } from "./use-header-rules";
import { useTerminalBrowserAnnotations } from "./use-annotations";
import { useTerminalBrowserDisplayScale } from "./use-display-scale";
import { useTerminalBrowserViewport } from "./use-viewport";
import { useTerminalBrowserWorkspaceActions } from "./use-workspace-actions";
import { useTerminalBrowserProfileResolution } from "./use-profile-resolution";
import { useTerminalBrowserControllerStore } from "./use-controller-store";
import type { TerminalBrowserControllerOptions } from "./controller-types";
import {
  buildTabStateFromElectronSnapshot,
  buildTabUpdateFromElectronSnapshot,
  buildTabUpdateFromElectronUpdate,
  type ElectronBrowserSnapshot,
  type ElectronBrowserUpdate,
  isNavigationAbortError,
  openUrlExternally,
} from "./model";

export function useTerminalBrowserController({
  active,
  nativeViewSuppressed,
  profileId,
  activationProjectId,
  activationRevision,
  apiBase,
  token,
  terminalSessionId,
}: TerminalBrowserControllerOptions) {
  const nativeViewActive = active && !nativeViewSuppressed;
  const {
    activeTabId,
    applyBrowserWorkspace,
    closeBrowserTab,
    createBrowserGroup,
    createBrowserTab,
    groups,
    reorderBrowserGroupTabs,
    setActiveBrowserTab,
    tabs,
    updateBrowserTab,
  } = useTerminalBrowserControllerStore();
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
    useTerminalBrowserHeaderRules(isElectron, profileId);
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
    clearTabBounds,
    horizontalViewport,
    resetHorizontalOffset,
    setHorizontalOffset,
    syncActiveTabBounds,
    syncBounds,
    setMinimumViewportWidth,
  } = useTerminalBrowserViewport({
    active: nativeViewActive,
    activeTab,
    annotationPanelOpen,
    browserViewRef,
    devicePanelOpen,
    electronTabsSynced,
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
    (tabId: string, update: ElectronBrowserUpdate, revision?: number) => {
      const tabUpdate = buildTabUpdateFromElectronUpdate(update);
      if (editingAddressTabIdRef.current === tabId) {
        const { addressInput, ...updateWithoutAddressInput } = tabUpdate;
        void addressInput;
        updateBrowserTab(tabId, updateWithoutAddressInput, revision);
        return;
      }
      updateBrowserTab(tabId, tabUpdate, revision);
    },
  );

  const applyElectronWorkspace = useMemoizedFn(
    (workspace: TerminalBrowserWorkspaceSnapshot, force = false): void => {
      const currentBrowserState = useTerminalPreviewStore.getState().browser;
      if (
        workspace.revision < currentBrowserState.revision ||
        (!force && workspace.revision === currentBrowserState.revision)
      ) {
        return;
      }
      const previousTabIds = new Set(
        currentBrowserState.tabs.map((tab) => tab.id),
      );
      for (const snapshot of workspace.tabs) {
        loadedUrlByTabRef.current[snapshot.tabId] = snapshot.url;
        previousTabIds.delete(snapshot.tabId);
      }
      for (const closedTabId of previousTabIds) {
        delete loadedUrlByTabRef.current[closedTabId];
        delete navigationSequenceByTabRef.current[closedTabId];
        clearTabBounds(closedTabId);
        handleAnnotationTabClosed(closedTabId);
      }
      applyBrowserWorkspace(
        workspace.revision,
        workspace.groups,
        workspace.tabs.map(buildTabStateFromElectronSnapshot),
        workspace.activeTabId,
        editingAddressTabIdRef.current,
        force,
      );
    },
  );

  const syncElectronTabs = useMemoizedFn(
    async (force = false): Promise<void> => {
      try {
        const workspace =
          await window.electronAPI?.terminalBrowserGetWorkspace?.(profileId);
        if (!workspace) {
          return;
        }
        applyElectronWorkspace(workspace, force);
        if (workspace.activeTabId && nativeViewActive) {
          await window.electronAPI?.terminalBrowserShow?.(
            workspace.activeTabId,
          );
          syncActiveTabBounds(workspace.activeTabId);
        }
      } finally {
        setElectronTabsSynced(true);
      }
    },
  );

  const { profileError, profileResolving } =
    useTerminalBrowserProfileResolution({
      active,
      activationProjectId,
      activationRevision,
      isElectron,
      profileId,
      setElectronTabsSynced,
      syncElectronTabs,
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

      resetHorizontalOffset(tabId);

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
    if (!activeTabId || !activeTabUrl || !nativeViewActive || !isElectron) {
      syncBounds(true);
      return;
    }

    if (loadedUrlByTabRef.current[activeTabId] !== activeTabUrl) {
      void navigateTab(activeTabId, activeTabUrl);
      return;
    }

    syncBounds(true);
  }, [
    activeTabId,
    activeTabUrl,
    electronTabsSynced,
    isElectron,
    navigateTab,
    nativeViewActive,
    syncBounds,
  ]);

  useEffect(() => {
    syncBounds(true);
  }, [annotationPanelOpen, devicePanelOpen, headerRulesPanelOpen, syncBounds]);

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
    if (!isElectron) {
      return;
    }
    const unsubscribe = window.electronAPI?.onTerminalBrowserStateChanged?.(
      (event) => {
        if (event.kind === "workspace") {
          if (event.workspace.profileId !== profileId) {
            return;
          }
          applyElectronWorkspace(event.workspace);
          if (event.workspace.activeTabId) {
            syncActiveTabBounds(event.workspace.activeTabId);
          }
          return;
        }
        if (event.tab.profileId !== profileId) {
          return;
        }
        const { tabId, ...update } = event.tab;
        const knownTab = useTerminalPreviewStore
          .getState()
          .browser.tabs.some((tab) => tab.id === tabId);
        if (!knownTab) {
          void syncElectronTabs().catch(() => undefined);
          return;
        }
        const previousUrl = loadedUrlByTabRef.current[tabId];
        if (previousUrl !== undefined && previousUrl !== update.url) {
          resetHorizontalOffset(tabId);
        }
        loadedUrlByTabRef.current[tabId] = update.url;
        applyElectronUpdate(tabId, event.tab, event.revision);
        syncActiveTabBounds(tabId);
      },
    );
    return unsubscribe;
  }, [
    applyElectronUpdate,
    applyElectronWorkspace,
    isElectron,
    profileId,
    resetHorizontalOffset,
    syncActiveTabBounds,
    syncElectronTabs,
  ]);

  const reorderTabs = useMemoizedFn(
    (groupId: string, fromIndex: number, toIndex: number): void => {
      const currentGroup = useTerminalPreviewStore
        .getState()
        .browser.groups.find((group) => group.id === groupId);
      if (
        !currentGroup ||
        fromIndex < 0 ||
        fromIndex >= currentGroup.tabIds.length ||
        toIndex < 0 ||
        toIndex >= currentGroup.tabIds.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const orderedTabIds = [...currentGroup.tabIds];
      const [movedTabId] = orderedTabIds.splice(fromIndex, 1);
      orderedTabIds.splice(toIndex, 0, movedTabId!);
      reorderBrowserGroupTabs(groupId, fromIndex, toIndex);
      if (!isElectron || !window.electronAPI?.terminalBrowserReorderGroupTabs) {
        return;
      }
      void window.electronAPI
        .terminalBrowserReorderGroupTabs(profileId, groupId, orderedTabIds)
        .catch(() => {
          void syncElectronTabs(true).catch(() => undefined);
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

  const { closeGroup, createGroup, createTab, renameGroup } =
    useTerminalBrowserWorkspaceActions({
      isElectron,
      profileId,
      createLocalTab: createBrowserTab,
      createLocalGroup: createBrowserGroup,
      closeLocalTab: closeBrowserTab,
      updateTab: updateBrowserTab,
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
    resetHorizontalOffset(activeTab.id);
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
    if (!isElectron || !window.electronAPI?.terminalBrowserCloseTab) {
      closeBrowserTab(tabId);
      return;
    }
    void window.electronAPI.terminalBrowserCloseTab(tabId).catch(() => {
      void syncElectronTabs().catch(() => undefined);
    });
  };

  return {
    activeTab,
    annotationPanelOpen,
    annotationError,
    annotationState,
    annotationSubmitting,
    browserViewRef,
    closeTab,
    closeGroup,
    closeAnnotationPanel,
    createBrowserTab: createTab,
    createBrowserGroup: createGroup,
    deleteAnnotation,
    devicePanelOpen,
    deviceSwitching,
    go,
    headerError,
    headerRules,
    headerRulesPanelOpen,
    headerSaving,
    horizontalViewport,
    handleAddressBlur,
    handleAddressFocus,
    isElectron,
    groups,
    mobileDisabledReason,
    openUrlExternally,
    openAnnotationPanel,
    profileError,
    profileId,
    profileResolving,
    reload,
    renameGroup,
    reorderTabs,
    saveHeaderRules,
    selectDevicePreset,
    setDisplayScale,
    setHorizontalOffset,
    setMinimumViewportWidth,
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
    toggleAnnotation,
    focusAnnotation,
    updateBrowserTab,
  };
}
