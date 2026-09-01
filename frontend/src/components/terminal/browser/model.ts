import type {
  TerminalBrowserSnapshot,
  TerminalBrowserTabSnapshot,
  TerminalBrowserUpdate,
} from "@runweave/shared/desktop-bridge";
import {
  DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
  isTerminalBrowserDisplayScale,
} from "@runweave/shared/terminal-browser-display-scale";
import { browserTabLabel } from "./tab-utils";
import {
  isTerminalBrowserMinimumViewportWidth,
  type TerminalBrowserMinimumViewportWidth,
} from "@runweave/shared/terminal-browser-minimum-width";

export type ElectronBrowserSnapshot = TerminalBrowserSnapshot;
export type ElectronBrowserUpdate = TerminalBrowserUpdate;
export type ElectronBrowserTabSnapshot = TerminalBrowserTabSnapshot;

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
    displayScale: normalizeDisplayScale(update.displayScale),
    minimumViewportWidth: normalizeMinimumViewportWidth(
      update.minimumViewportWidth,
    ),
    faviconDataUrl: update.faviconDataUrl,
    navigationError: update.navigationError,
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
    displayScale: normalizeDisplayScale(snapshot.displayScale),
    minimumViewportWidth: normalizeMinimumViewportWidth(
      snapshot.minimumViewportWidth,
    ),
    faviconDataUrl: snapshot.faviconDataUrl,
    navigationError: snapshot.navigationError,
  };
}

function normalizeDisplayScale(value: unknown): number {
  return isTerminalBrowserDisplayScale(value)
    ? value
    : DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE;
}

function normalizeMinimumViewportWidth(
  value: unknown,
): TerminalBrowserMinimumViewportWidth {
  return isTerminalBrowserMinimumViewportWidth(value) ? value : null;
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
