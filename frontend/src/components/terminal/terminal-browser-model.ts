import type { TerminalBrowserDeviceState } from "@browser-viewer/shared";
import { browserTabLabel } from "./terminal-browser-tabs";

export interface ElectronBrowserSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ElectronBrowserUpdate extends ElectronBrowserSnapshot {
  loading: boolean;
  cdpProxyAttached?: boolean;
  devtoolsOpen?: boolean;
  deviceState?: TerminalBrowserDeviceState;
}

export interface ElectronBrowserTabSnapshot extends ElectronBrowserUpdate {
  tabId: string;
  active: boolean;
  cdpProxyAttached: boolean;
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
  return {
    url: snapshot.url,
    addressInput: snapshot.url,
    title: snapshot.title || browserTabLabel("", snapshot.url),
    loading: false,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    error: undefined,
  };
}

export function buildTabUpdateFromElectronUpdate(
  update: ElectronBrowserUpdate,
) {
  return {
    url: update.url,
    addressInput: update.url,
    title: update.title || browserTabLabel("", update.url),
    loading: update.loading,
    canGoBack: update.canGoBack,
    canGoForward: update.canGoForward,
    cdpProxyAttached: update.cdpProxyAttached,
    devtoolsOpen: update.devtoolsOpen,
    deviceState: update.deviceState,
    error: undefined,
  };
}

export function buildTabStateFromElectronSnapshot(
  snapshot: ElectronBrowserTabSnapshot,
) {
  return {
    id: snapshot.tabId,
    url: snapshot.url,
    addressInput: snapshot.url,
    title: snapshot.title || browserTabLabel("", snapshot.url),
    loading: snapshot.loading,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    cdpProxyAttached: snapshot.cdpProxyAttached,
    devtoolsOpen: snapshot.devtoolsOpen,
    deviceState: snapshot.deviceState,
  };
}
