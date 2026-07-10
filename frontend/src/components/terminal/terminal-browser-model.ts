import type { TerminalBrowserDeviceState } from "@runweave/shared";
import { browserTabLabel } from "./terminal-browser-tab-utils";

export interface ElectronBrowserSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ElectronBrowserUpdate extends ElectronBrowserSnapshot {
  browserGroupId?: string;
  loading: boolean;
  cdpProxyAttached?: boolean;
  mcpActivityUntil?: number | null;
  devtoolsOpen?: boolean;
  deviceState?: TerminalBrowserDeviceState;
}

export interface ElectronBrowserTabSnapshot extends ElectronBrowserUpdate {
  tabId: string;
  browserGroupId: string;
  active: boolean;
  cdpProxyAttached: boolean;
  mcpActivityUntil: number | null;
  devtoolsOpen: boolean;
  deviceState: TerminalBrowserDeviceState;
}

export function openUrlExternally(url: string): void {
  if (window.electronAPI?.openExternal) {
    void window.electronAPI.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function isNavigationAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("ERR_ABORTED") || error.message.includes("(-3)")
  );
}

export function buildTabUpdateFromElectronSnapshot(
  snapshot: ElectronBrowserSnapshot,
) {
  const url = normalizeElectronBrowserUrl(snapshot.url);
  return {
    url,
    addressInput: url,
    title: getElectronBrowserTitle(snapshot.title, url),
    loading: false,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    error: undefined,
  };
}

export function buildTabUpdateFromElectronUpdate(
  update: ElectronBrowserUpdate,
) {
  const url = normalizeElectronBrowserUrl(update.url);
  return {
    url,
    addressInput: url,
    title: getElectronBrowserTitle(update.title, url),
    loading: update.loading,
    canGoBack: update.canGoBack,
    canGoForward: update.canGoForward,
    browserGroupId: update.browserGroupId,
    cdpProxyAttached: update.cdpProxyAttached,
    mcpActivityUntil: update.mcpActivityUntil,
    devtoolsOpen: update.devtoolsOpen,
    deviceState: update.deviceState,
    error: undefined,
  };
}

export function buildTabStateFromElectronSnapshot(
  snapshot: ElectronBrowserTabSnapshot,
) {
  const url = normalizeElectronBrowserUrl(snapshot.url);
  return {
    id: snapshot.tabId,
    browserGroupId: snapshot.browserGroupId,
    url,
    addressInput: url,
    title: getElectronBrowserTitle(snapshot.title, url),
    loading: snapshot.loading,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    cdpProxyAttached: snapshot.cdpProxyAttached,
    mcpActivityUntil: snapshot.mcpActivityUntil,
    devtoolsOpen: snapshot.devtoolsOpen,
    deviceState: snapshot.deviceState,
  };
}

function normalizeElectronBrowserUrl(url: string): string {
  return url === "about:blank" ? "" : url;
}

function getElectronBrowserTitle(title: string, url: string): string {
  if (!url && (!title.trim() || title.trim() === "about:blank")) {
    return browserTabLabel("", "");
  }
  return browserTabLabel(title, url);
}
