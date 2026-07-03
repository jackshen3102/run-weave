import React from "react";
import { createRoot } from "react-dom/client";
import { TerminalBrowserTabs } from "../components/terminal/terminal-browser-tabs";

interface HarnessTab {
  id: string;
  title: string;
  url: string;
  cdpProxyAttached?: boolean;
  mcpActivityUntil?: number | null;
}

declare global {
  interface Window {
    closedTerminalBrowserTabIds?: string[];
    renderTerminalBrowserTabsHarness?: (
      tabs: HarnessTab[],
      activeTabId?: string,
    ) => void;
  }
}

window.renderTerminalBrowserTabsHarness = (tabs, activeTabId) => {
  window.closedTerminalBrowserTabIds = [];

  const host = document.createElement("div");
  host.id = "terminal-browser-tabs-harness";
  host.className = "dark";
  host.style.width = "760px";
  host.style.background = "#020617";
  document.body.replaceChildren(host);

  const fullTabs = tabs.map((tab) => ({
    ...tab,
    addressInput: tab.url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    deviceState: {
      presetId: "desktop" as const,
      label: "Desktop",
      mobile: false,
      viewport: null,
    },
  }));

  createRoot(host).render(
    <TerminalBrowserTabs
      tabs={fullTabs}
      activeTabId={activeTabId ?? tabs[0]?.id ?? ""}
      onCreateTab={() => undefined}
      onSelectTab={() => undefined}
      onCloseTab={(_event, tabId) => {
        window.closedTerminalBrowserTabIds?.push(tabId);
      }}
    />,
  );
};
