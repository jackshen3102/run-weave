import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import type { TerminalBrowserTabState } from "../../../../features/terminal/preview/store";
import { useBookmarks } from "../bookmarks/use-bookmarks";
interface ControllerBookmarkOptions {
  active: boolean;
  tab: TerminalBrowserTabState | undefined;
  profileId: TerminalBrowserProfileId;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  onOpen: () => void;
  navigateTab: (
    tabId: string,
    url: string,
    source: "bookmark",
  ) => Promise<void>;
}
export function useControllerBookmarks(options: ControllerBookmarkOptions) {
  return useBookmarks({
    active: options.active,
    tab: options.tab,
    profileId: options.profileId,
    panelOpen: options.panelOpen,
    setPanelOpen: (open) => {
      options.setPanelOpen(open);
      if (open) options.onOpen();
    },
    navigate: async (url) => {
      if (options.tab)
        await options.navigateTab(options.tab.id, url, "bookmark");
    },
    createTab: async (url) => {
      const tab = options.tab;
      if (!tab || !window.electronAPI?.terminalBrowserCreateTab) return;
      await window.electronAPI.terminalBrowserCreateTab({
        profileId: options.profileId,
        placement: "current-group",
        groupId: tab.browserGroupId,
        openerTabId: tab.id,
        url,
      });
    },
  });
}
