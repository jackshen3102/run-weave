import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import { DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE } from "@runweave/shared/terminal-browser-display-scale";
import { TerminalBrowserTabs } from "../components/terminal/terminal-browser-tabs";
import type { TerminalBrowserTabState } from "../features/terminal/preview-store";

interface HarnessTab {
  id: string;
  title: string;
  url: string;
  browserGroupId?: string;
  loading?: boolean;
  cdpProxyAttached?: boolean;
  mcpActivityUntil?: number | null;
}

interface HarnessState {
  tabs: HarnessTab[];
  activeTabId: string;
  selectedTabIds: string[];
  closedTabIds: string[];
  createdTabIds: string[];
  reorders: Array<{ fromIndex: number; toIndex: number }>;
}

declare global {
  interface Window {
    terminalBrowserTabsHarnessState?: HarnessState;
    renderTerminalBrowserTabsHarness?: (
      tabs: HarnessTab[],
      activeTabId?: string,
      width?: number,
    ) => void;
    setTerminalBrowserTabsHarnessWidth?: (width: number) => void;
  }
}

let harnessRoot: Root | null = null;

function normalizeHarnessTab(tab: HarnessTab): TerminalBrowserTabState {
  return {
    ...tab,
    browserGroupId: tab.browserGroupId ?? "harness-group-default",
    addressInput: tab.url,
    loading: tab.loading ?? false,
    canGoBack: false,
    canGoForward: false,
    deviceState: createTerminalBrowserDeviceState("desktop"),
    displayScale: DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
    faviconDataUrl: null,
    navigationError: null,
  };
}

function TerminalBrowserTabsHarness({
  initialTabs,
  initialActiveTabId,
}: {
  initialTabs: TerminalBrowserTabState[];
  initialActiveTabId: string;
}) {
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTabId, setActiveTabId] = useState(initialActiveTabId);
  const [selectedTabIds, setSelectedTabIds] = useState<string[]>([]);
  const [closedTabIds, setClosedTabIds] = useState<string[]>([]);
  const [createdTabIds, setCreatedTabIds] = useState<string[]>([]);
  const [reorders, setReorders] = useState<
    Array<{ fromIndex: number; toIndex: number }>
  >([]);
  const groups = useMemo(() => {
    const result: Array<{
      id: string;
      name: string;
      nameOrigin: "automatic";
      tabIds: string[];
    }> = [];
    for (const tab of tabs) {
      let group = result.find((candidate) => candidate.id === tab.browserGroupId);
      if (!group) {
        group = {
          id: tab.browserGroupId,
          name: `Group ${tab.browserGroupId.slice(-6)}`,
          nameOrigin: "automatic",
          tabIds: [],
        };
        result.push(group);
      }
      group.tabIds.push(tab.id);
    }
    return result;
  }, [tabs]);

  useEffect(() => {
    window.terminalBrowserTabsHarnessState = {
      tabs,
      activeTabId,
      selectedTabIds,
      closedTabIds,
      createdTabIds,
      reorders,
    };
  }, [activeTabId, closedTabIds, createdTabIds, reorders, selectedTabIds, tabs]);

  return (
    <TerminalBrowserTabs
      tabs={tabs}
      groups={groups}
      activeTabId={activeTabId}
      onCreateTab={() => {
        const id = `harness-new-${createdTabIds.length + 1}`;
        const browserGroupId =
          tabs.find((tab) => tab.id === activeTabId)?.browserGroupId;
        const nextTab = normalizeHarnessTab({
          id,
          title: "",
          url: "",
          browserGroupId,
        });
        setTabs((currentTabs) => [...currentTabs, nextTab]);
        setActiveTabId(id);
        setCreatedTabIds((ids) => [...ids, id]);
      }}
      onCreateGroup={() => undefined}
      onSelectTab={(tabId) => {
        setActiveTabId(tabId);
        setSelectedTabIds((ids) => [...ids, tabId]);
      }}
      onCloseTab={(_event, tabId) => {
        setTabs((currentTabs) => {
          const closingIndex = currentTabs.findIndex((tab) => tab.id === tabId);
          if (closingIndex < 0) {
            return currentTabs;
          }
          const remainingTabs = currentTabs.filter((tab) => tab.id !== tabId);
          if (remainingTabs.length === 0) {
            const replacement = normalizeHarnessTab({
              id: "harness-replacement",
              title: "",
              url: "",
            });
            setActiveTabId(replacement.id);
            return [replacement];
          }
          if (activeTabId === tabId) {
            setActiveTabId(
              remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)]!.id,
            );
          }
          return remainingTabs;
        });
        setClosedTabIds((ids) => [...ids, tabId]);
      }}
      onReorder={(groupId, fromIndex, toIndex) => {
        setTabs((currentTabs) => {
          const memberIndexes = currentTabs.flatMap((tab, index) =>
            tab.browserGroupId === groupId ? [index] : [],
          );
          const nextTabs = [...currentTabs];
          const sourceIndex = memberIndexes[fromIndex];
          const targetIndex = memberIndexes[toIndex];
          if (sourceIndex === undefined || targetIndex === undefined) {
            return currentTabs;
          }
          const [movedTab] = nextTabs.splice(sourceIndex, 1);
          if (!movedTab) {
            return currentTabs;
          }
          nextTabs.splice(targetIndex, 0, movedTab);
          return nextTabs;
        });
        setReorders((items) => [...items, { fromIndex, toIndex }]);
      }}
      onRenameGroup={async () => undefined}
      onCloseGroup={async () => undefined}
    />
  );
}

window.setTerminalBrowserTabsHarnessWidth = (width) => {
  const host = document.getElementById("terminal-browser-tabs-harness");
  if (host) {
    host.style.width = `${width}px`;
  }
};

window.renderTerminalBrowserTabsHarness = (tabs, activeTabId, width = 760) => {
  harnessRoot?.unmount();
  const host = document.createElement("div");
  host.id = "terminal-browser-tabs-harness";
  host.className = "dark";
  host.style.width = `${width}px`;
  host.style.background = "#020617";
  document.body.replaceChildren(host);

  const fullTabs = tabs.map(normalizeHarnessTab);
  const initialActiveTabId = activeTabId ?? fullTabs[0]?.id ?? "";
  harnessRoot = createRoot(host);
  harnessRoot.render(
    <TerminalBrowserTabsHarness
      initialTabs={fullTabs}
      initialActiveTabId={initialActiveTabId}
    />,
  );
};
