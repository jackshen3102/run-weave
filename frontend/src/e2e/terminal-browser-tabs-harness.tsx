import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
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
    addressInput: tab.url,
    loading: tab.loading ?? false,
    canGoBack: false,
    canGoForward: false,
    deviceState: createTerminalBrowserDeviceState("desktop"),
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
      activeTabId={activeTabId}
      onCreateTab={() => {
        const id = `harness-new-${createdTabIds.length + 1}`;
        const nextTab = normalizeHarnessTab({ id, title: "", url: "" });
        setTabs((currentTabs) => [...currentTabs, nextTab]);
        setActiveTabId(id);
        setCreatedTabIds((ids) => [...ids, id]);
      }}
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
      onReorder={(fromIndex, toIndex) => {
        setTabs((currentTabs) => {
          const nextTabs = [...currentTabs];
          const [movedTab] = nextTabs.splice(fromIndex, 1);
          if (!movedTab) {
            return currentTabs;
          }
          nextTabs.splice(toIndex, 0, movedTab);
          return nextTabs;
        });
        setReorders((items) => [...items, { fromIndex, toIndex }]);
      }}
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
