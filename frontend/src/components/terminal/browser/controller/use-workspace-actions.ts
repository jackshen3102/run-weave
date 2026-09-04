import { useMemoizedFn } from "ahooks";
import type { TerminalBrowserTabState } from "../../../../features/terminal/preview/store";
import { useTerminalPreviewStore } from "../../../../features/terminal/preview/store";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

interface TerminalBrowserWorkspaceActionsOptions {
  isElectron: boolean;
  profileId: TerminalBrowserProfileId;
  createLocalTab: (url?: string) => void;
  createLocalGroup: (url?: string) => void;
  closeLocalTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<TerminalBrowserTabState>) => void;
}

export function useTerminalBrowserWorkspaceActions({
  isElectron,
  profileId,
  createLocalTab,
  createLocalGroup,
  closeLocalTab,
  updateTab,
}: TerminalBrowserWorkspaceActionsOptions) {
  const createTab = useMemoizedFn((url?: string): void => {
    const browser = useTerminalPreviewStore.getState().browser;
    const activeTab = browser.tabs.find(
      (tab) => tab.id === browser.activeTabId,
    );
    if (!activeTab) {
      return;
    }
    if (!isElectron || !window.electronAPI?.terminalBrowserCreateTab) {
      createLocalTab(url);
      return;
    }
    void window.electronAPI
      .terminalBrowserCreateTab({
        profileId,
        placement: "current-group",
        groupId: activeTab.browserGroupId,
        openerTabId: activeTab.id,
        ...(url ? { url } : {}),
      })
      .catch((error) => {
        updateTab(activeTab.id, {
          error:
            error instanceof Error ? error.message : "Failed to create tab",
        });
      });
  });

  const createGroup = useMemoizedFn((): void => {
    if (!isElectron || !window.electronAPI?.terminalBrowserCreateTab) {
      createLocalGroup();
      return;
    }
    void window.electronAPI
      .terminalBrowserCreateTab({ profileId, placement: "new-group" })
      .catch((error) => {
        updateTab(useTerminalPreviewStore.getState().browser.activeTabId, {
          error:
            error instanceof Error ? error.message : "Failed to create group",
        });
      });
  });

  const renameGroup = useMemoizedFn(
    async (groupId: string, name: string): Promise<void> => {
      if (!window.electronAPI?.terminalBrowserRenameGroup) {
        throw new Error("Group rename is unavailable");
      }
      await window.electronAPI.terminalBrowserRenameGroup(
        profileId,
        groupId,
        name,
      );
    },
  );

  const closeGroup = useMemoizedFn(async (groupId: string): Promise<void> => {
    if (!window.electronAPI?.terminalBrowserCloseGroup) {
      const group = useTerminalPreviewStore
        .getState()
        .browser.groups.find((candidate) => candidate.id === groupId);
      for (const tabId of group?.tabIds ?? []) {
        closeLocalTab(tabId);
      }
      return;
    }
    await window.electronAPI.terminalBrowserCloseGroup(profileId, groupId);
  });

  return { closeGroup, createGroup, createTab, renameGroup };
}
