import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, type RefObject } from "react";
import { aiDiagnosticLog } from "../../features/diagnostic-logs/recorder";

const TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX = 320;

interface BrowserBoundsTab {
  id: string;
  deviceState: {
    mobile: boolean;
    presetId: string;
    viewport?: {
      width: number;
      height: number;
    } | null;
  };
}

interface UseTerminalBrowserBoundsParams {
  active: boolean;
  activeTabId: string | null | undefined;
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

  const clearTabBounds = useMemoizedFn((tabId: string): void => {
    delete deviceViewportByTabRef.current[tabId];
    delete lastBoundsKeyByTabRef.current[tabId];
  });

  const syncBoundsForTab = useMemoizedFn((tabId: string, immediate = false) => {
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
      const containerRect =
        surfaceContainerRef.current?.getBoundingClientRect();
      const sidePanelOpen = headerRulesPanelOpen || devicePanelOpen;
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

  const cancelPendingBoundsSync = useMemoizedFn((): void => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  });

  return {
    cancelPendingBoundsSync,
    clearTabBounds,
    syncActiveTabBounds,
    syncBounds,
  };
}
