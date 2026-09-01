import { useShallow } from "zustand/react/shallow";
import { useTerminalPreviewStore } from "../../../features/terminal/preview-store";

export function useTerminalBrowserControllerStore() {
  return useTerminalPreviewStore(
    useShallow((state) => ({
      activeTabId: state.browser.activeTabId,
      applyBrowserWorkspace: state.applyBrowserWorkspace,
      closeBrowserTab: state.closeBrowserTab,
      createBrowserGroup: state.createBrowserGroup,
      createBrowserTab: state.createBrowserTab,
      groups: state.browser.groups,
      reorderBrowserGroupTabs: state.reorderBrowserGroupTabs,
      setActiveBrowserTab: state.setActiveBrowserTab,
      tabs: state.browser.tabs,
      updateBrowserTab: state.updateBrowserTab,
    })),
  );
}
