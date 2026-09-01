import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  getTerminalBrowserContentWidth,
  type TerminalBrowserMinimumViewportWidth,
} from "@runweave/shared/terminal-browser-minimum-width";
import { aiDiagnosticLog } from "../../../features/diagnostic-logs/recorder";

const TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX = 320;

interface BrowserBoundsTab {
  id: string;
  displayScale: number;
  minimumViewportWidth: TerminalBrowserMinimumViewportWidth;
  deviceState: {
    mobile: boolean;
    presetId: string;
    viewport?: {
      width: number;
      height: number;
    } | null;
  };
}

export interface TerminalBrowserHorizontalViewportState {
  contentWidth: number;
  overflowing: boolean;
  scrollLeft: number;
}

const EMPTY_HORIZONTAL_VIEWPORT: TerminalBrowserHorizontalViewportState = {
  contentWidth: 1,
  overflowing: false,
  scrollLeft: 0,
};

interface UseTerminalBrowserBoundsParams {
  active: boolean;
  activeTabId: string | null | undefined;
  annotationPanelOpen: boolean;
  browserViewRef: RefObject<HTMLDivElement | null>;
  devicePanelOpen: boolean;
  headerRulesPanelOpen: boolean;
  isElectron: boolean;
  surfaceContainerRef: RefObject<HTMLDivElement | null>;
  tabs: BrowserBoundsTab[];
  updateBrowserTab: (
    tabId: string,
    update: { error?: string | undefined },
  ) => void;
}

export function useTerminalBrowserBounds({
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
}: UseTerminalBrowserBoundsParams) {
  const frameRef = useRef<number | null>(null);
  const activeTabIdRef = useRef(activeTabId);
  const activeRef = useRef(active);
  const tabLayoutByIdRef = useRef<
    Record<
      string,
      | {
          displayScale: number;
          minimumViewportWidth: TerminalBrowserMinimumViewportWidth;
          mobile: boolean;
        }
      | undefined
    >
  >({});
  const scrollLeftByTabIdRef = useRef<Record<string, number | undefined>>({});
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
  const [horizontalViewport, setHorizontalViewport] =
    useState<TerminalBrowserHorizontalViewportState>(EMPTY_HORIZONTAL_VIEWPORT);

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
    const nextLayouts: typeof tabLayoutByIdRef.current = {};
    for (const tab of tabs) {
      nextViewports[tab.id] =
        tab.deviceState.mobile && tab.deviceState.viewport
          ? { mobile: true, width: tab.deviceState.viewport.width }
          : { mobile: false, width: 1 };
      nextLayouts[tab.id] = {
        displayScale: tab.displayScale,
        minimumViewportWidth: tab.minimumViewportWidth,
        mobile: tab.deviceState.mobile,
      };
    }
    deviceViewportByTabRef.current = nextViewports;
    tabLayoutByIdRef.current = nextLayouts;
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

  const clearTabBounds = useMemoizedFn(
    (tabId: string, preserveHorizontalOffset = false): void => {
      if (preserveHorizontalOffset) {
        delete lastBoundsKeyByTabRef.current[tabId];
        return;
      }
      delete deviceViewportByTabRef.current[tabId];
      delete tabLayoutByIdRef.current[tabId];
      delete scrollLeftByTabIdRef.current[tabId];
      delete lastBoundsKeyByTabRef.current[tabId];
    },
  );

  const updateHorizontalViewport = useMemoizedFn(
    (next: TerminalBrowserHorizontalViewportState): void => {
      setHorizontalViewport((current) =>
        current.contentWidth === next.contentWidth &&
        current.overflowing === next.overflowing &&
        current.scrollLeft === next.scrollLeft
          ? current
          : next,
      );
    },
  );

  const syncBoundsForTab = useMemoizedFn((tabId: string, immediate = false) => {
    if (!isElectron) {
      return;
    }

    const sendBounds = (): void => {
      frameRef.current = null;
      if (activeTabIdRef.current !== tabId) {
        return;
      }
      if (!activeRef.current) {
        void window.electronAPI?.terminalBrowserHide?.(tabId);
        delete lastBoundsKeyByTabRef.current[tabId];
        updateHorizontalViewport(EMPTY_HORIZONTAL_VIEWPORT);
        return;
      }
      const rect = browserViewRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const containerRect =
        surfaceContainerRef.current?.getBoundingClientRect();
      const sidePanelOpen =
        annotationPanelOpen || headerRulesPanelOpen || devicePanelOpen;
      const rawBounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const maxRight =
        containerRect && sidePanelOpen
          ? Math.round(
              containerRect.right - TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX,
            )
          : null;
      const clippedWidth =
        maxRight === null
          ? rawBounds.width
          : Math.max(
              0,
              Math.min(rawBounds.x + rawBounds.width, maxRight) - rawBounds.x,
            );
      if (clippedWidth <= 0) {
        return;
      }
      const viewport = deviceViewportByTabRef.current[tabId];
      const layout = tabLayoutByIdRef.current[tabId];
      const emulationScale =
        viewport?.mobile && viewport.width > 0
          ? clippedWidth / viewport.width
          : 1;
      const contentWidth = getTerminalBrowserContentWidth(
        clippedWidth,
        layout?.minimumViewportWidth ?? null,
        layout?.displayScale ?? 1,
        layout?.mobile ?? false,
      );
      const maximumScrollLeft = Math.max(0, contentWidth - clippedWidth);
      const requestedScrollLeft = scrollLeftByTabIdRef.current[tabId] ?? 0;
      const scrollLeft =
        layout?.mobile === true
          ? 0
          : Math.max(
              0,
              Math.min(Math.round(requestedScrollLeft), maximumScrollLeft),
            );
      scrollLeftByTabIdRef.current[tabId] = scrollLeft;
      updateHorizontalViewport({
        contentWidth,
        overflowing: maximumScrollLeft > 0,
        scrollLeft,
      });
      const nextBounds = {
        x: rawBounds.x,
        y: rawBounds.y,
        width: clippedWidth,
        height: rawBounds.height,
        emulationScale,
        horizontalOffsetX: scrollLeft,
      };
      const boundsKey = [
        nextBounds.x,
        nextBounds.y,
        nextBounds.width,
        nextBounds.height,
        nextBounds.emulationScale.toFixed(4),
        nextBounds.horizontalOffsetX,
        contentWidth,
        layout?.minimumViewportWidth ?? "auto",
        layout?.displayScale ?? 1,
        layout?.mobile ? "mobile" : "desktop",
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
        contentWidth,
        horizontalOffsetX: scrollLeft,
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
  });

  const syncBounds = useMemoizedFn((immediate = false) => {
    if (!activeTabId) {
      return;
    }
    syncBoundsForTab(activeTabId, immediate);
  });

  const syncActiveTabBounds = useMemoizedFn((tabId: string) => {
    if (activeTabIdRef.current === tabId) {
      syncBoundsForTab(tabId, true);
    }
  });

  const resetHorizontalOffset = useMemoizedFn((tabId: string): void => {
    scrollLeftByTabIdRef.current[tabId] = 0;
    delete lastBoundsKeyByTabRef.current[tabId];
    if (activeTabIdRef.current === tabId) {
      setHorizontalViewport((current) => ({ ...current, scrollLeft: 0 }));
      syncBoundsForTab(tabId, true);
    }
  });

  const setHorizontalOffset = useMemoizedFn((scrollLeft: number): void => {
    const tabId = activeTabIdRef.current;
    if (!tabId || !Number.isFinite(scrollLeft)) {
      return;
    }
    scrollLeftByTabIdRef.current[tabId] = Math.max(0, scrollLeft);
    syncBoundsForTab(tabId);
  });

  const cancelPendingBoundsSync = useMemoizedFn((): void => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  });

  return {
    cancelPendingBoundsSync,
    clearTabBounds,
    horizontalViewport,
    resetHorizontalOffset,
    setHorizontalOffset,
    syncActiveTabBounds,
    syncBounds,
  };
}
