import { useMemoizedFn } from "ahooks";
import type { TerminalBrowserMinimumViewportWidth } from "@runweave/shared/terminal-browser-minimum-width";
import { useTerminalPreviewStore } from "../../../features/terminal/preview-store";

interface UseMinimumViewportWidthOptions {
  activeTabId: string | null | undefined;
  isElectron: boolean;
  onApplied: (tabId: string) => void;
}

export function useTerminalBrowserMinimumViewportWidth({
  activeTabId,
  isElectron,
  onApplied,
}: UseMinimumViewportWidthOptions) {
  const updateBrowserTab = useTerminalPreviewStore(
    (state) => state.updateBrowserTab,
  );

  return useMemoizedFn(
    async (width: TerminalBrowserMinimumViewportWidth): Promise<void> => {
      if (!activeTabId || !isElectron) {
        return;
      }
      const currentWidth = useTerminalPreviewStore
        .getState()
        .browser.tabs.find(
          (tab) => tab.id === activeTabId,
        )?.minimumViewportWidth;
      if (currentWidth === width) {
        return;
      }
      updateBrowserTab(activeTabId, { error: undefined });
      try {
        const state =
          await window.electronAPI?.terminalBrowserSetMinimumViewportWidth?.(
            activeTabId,
            width,
          );
        if (state) {
          updateBrowserTab(activeTabId, {
            minimumViewportWidth: state.width,
            error: undefined,
          });
          onApplied(activeTabId);
        }
      } catch (error) {
        updateBrowserTab(activeTabId, {
          error:
            error instanceof Error
              ? error.message
              : "Failed to update browser minimum viewport width",
        });
      }
    },
  );
}
