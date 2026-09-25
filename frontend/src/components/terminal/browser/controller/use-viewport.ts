import { setBrowserPresentationHost } from "../../../../features/terminal/browser-presentation/coordinator";
import { useEffect, useLayoutEffect, type RefObject } from "react";
import type {
  TerminalBrowserTabState,
  TerminalPreviewStore,
} from "../../../../features/terminal/preview/store-types";
import { useTerminalBrowserBounds } from "./use-bounds";
import { useTerminalBrowserMinimumViewportWidth } from "../device/use-minimum-width";

interface UseTerminalBrowserViewportOptions {
  active: boolean;
  activeTab: TerminalBrowserTabState | undefined;
  annotationPanelOpen: boolean;
  browserViewRef: RefObject<HTMLDivElement | null>;
  devicePanelOpen: boolean;
  electronTabsSynced: boolean;
  headerRulesPanelOpen: boolean;
  isElectron: boolean;
  surfaceContainerRef: RefObject<HTMLDivElement | null>;
  tabs: TerminalBrowserTabState[];
  updateBrowserTab: TerminalPreviewStore["updateBrowserTab"];
}

export function useTerminalBrowserViewport({
  active,
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
}: UseTerminalBrowserViewportOptions) {
  const activeTabId = activeTab?.id;
  const {
    cancelPendingBoundsSync,
    clearTabBounds,
    horizontalViewport,
    resetHorizontalOffset,
    setHorizontalOffset,
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
  const setMinimumViewportWidth = useTerminalBrowserMinimumViewportWidth({
    activeTabId,
    isElectron,
    onApplied: resetHorizontalOffset,
  });

  useEffect(() => {
    syncBounds(true);
  }, [
    activeTab?.deviceState,
    activeTab?.displayScale,
    activeTab?.minimumViewportWidth,
    syncBounds,
  ]);

  useLayoutEffect(() => {
    if (!isElectron) return;
    void setBrowserPresentationHost(active && electronTabsSynced, activeTabId ?? null);
  }, [active, activeTabId, electronTabsSynced, isElectron]);

  // A target change is not a host unmount: keep an existing overlay acknowledged.
  useLayoutEffect(() => {
    if (!isElectron) return;
    return () => { void setBrowserPresentationHost(false, null); };
  }, [isElectron]);

  useEffect(() => {
    if (!isElectron || !electronTabsSynced || !activeTabId) {
      return;
    }
    if (!active) {
      void window.electronAPI?.terminalBrowserHide?.(activeTabId);
      clearTabBounds(activeTabId, true);
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
    void window.electronAPI?.terminalBrowserShow?.(activeTabId);
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
    surfaceContainerRef,
    syncBounds,
  ]);

  return {
    cancelPendingBoundsSync,
    clearTabBounds,
    horizontalViewport,
    resetHorizontalOffset,
    setHorizontalOffset,
    setMinimumViewportWidth,
    syncActiveTabBounds,
    syncBounds,
  };
}
