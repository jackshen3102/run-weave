import { useMemoizedFn } from "ahooks";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";

export function useTerminalBrowserDisplayScale(
  activeTabId: string | null | undefined,
  isElectron: boolean,
) {
  const updateBrowserTab = useTerminalPreviewStore(
    (state) => state.updateBrowserTab,
  );

  return useMemoizedFn(async (factor: number): Promise<void> => {
    if (!activeTabId || !isElectron) {
      return;
    }
    updateBrowserTab(activeTabId, { error: undefined });
    try {
      const state =
        await window.electronAPI?.terminalBrowserSetDisplayScale?.(
          activeTabId,
          factor,
        );
      if (state) {
        updateBrowserTab(activeTabId, {
          displayScale: state.factor,
          error: undefined,
        });
      }
    } catch (error) {
      updateBrowserTab(activeTabId, {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update browser display scale",
      });
    }
  });
}
