import {
  session as electronSession,
  type WebContents,
  type WebContentsView,
  type View,
} from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  TerminalBrowserBounds,
  TerminalBrowserUpdate,
} from "@runweave/shared/desktop-bridge";
import type { TerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import type { TerminalBrowserMinimumViewportWidth } from "@runweave/shared/terminal-browser-minimum-width";
import type { TerminalBrowserGroupNameOrigin } from "@runweave/shared/terminal-browser-workspace";
import {
  getTerminalBrowserProfileConfig,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";

export type {
  TerminalBrowserBounds,
  TerminalBrowserSnapshot,
  TerminalBrowserTabSnapshot,
  TerminalBrowserUpdate,
} from "@runweave/shared/desktop-bridge";

export interface PendingTerminalBrowserUpdate {
  update: TerminalBrowserUpdate;
  updateKey: string;
}

export interface TerminalBrowserEntry {
  windowId: number;
  profileId: TerminalBrowserProfileId;
  view: WebContentsView;
  viewportView: View;
  viewportBounds: TerminalBrowserBounds | null;
  horizontalOffsetX: number;
  attached: boolean;
  visible: boolean;
  targetId: string;
  browserGroupId: string;
  faviconDataUrl: string | null;
  faviconGeneration: number;
  navigationError: string | null;
  cdpProxyAttached: boolean;
  mcpActivityUntil: number | null;
  devtoolsOpen: boolean;
  deviceState: TerminalBrowserDeviceState;
  displayScale: number;
  minimumViewportWidth: TerminalBrowserMinimumViewportWidth;
  emulationScale: number;
  automationDeviceMetrics: Record<string, unknown> | null;
  metricsMutationQueue: Promise<void>;
  metricsMutationClosed: boolean;
  defaultUserAgent: string;
  deviceDebuggerAttached: boolean;
  onDeviceDebuggerDetach:
    | ((event: Electron.Event, reason: string) => void)
    | null;
  lastActiveAt: number;
  lastKnownUrl: string;
  lastSentUpdateKey: string | null;
  lastSentUpdateAt: number;
  pendingUpdate: PendingTerminalBrowserUpdate | null;
  pendingUpdateTimer: NodeJS.Timeout | null;
}

export interface TerminalBrowserGroupRecord {
  id: string;
  name: string;
  nameOrigin: TerminalBrowserGroupNameOrigin;
  tabIds: string[];
}

export interface TerminalBrowserWindowWorkspace {
  profileId: TerminalBrowserProfileId;
  revision: number;
  groups: TerminalBrowserGroupRecord[];
}

export interface TerminalBrowserDormantTab {
  windowId: number;
  profileId: TerminalBrowserProfileId;
  tabId: string;
  browserGroupId: string;
  url: string;
  title: string;
  lastActiveAt: number;
}

export interface TerminalBrowserCdpTarget {
  key: string;
  tabId: string;
  targetId: string;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string;
  windowId: number;
  active: boolean;
  lastActiveAt: number;
  url: string;
  title: string;
  faviconDataUrl: string | null;
  loading: boolean;
  webContents: WebContents;
}

export const terminalBrowserRuntime = {
  entries: new Map<string, TerminalBrowserEntry>(),
  dormantTabs: new Map<string, TerminalBrowserDormantTab>(),
  attachedByWorkspaceKey: new Map<string, string>(),
  workspaceByKey: new Map<string, TerminalBrowserWindowWorkspace>(),
  saveTimer: null as NodeJS.Timeout | null,
  persistedStateRestored: false,
  restoringWorkspaceKeys: new Set<string>(),
};

export const terminalBrowserEvents = new EventEmitter();

export function createTerminalBrowserGroupId(): string {
  return `browser-group-${randomUUID().slice(0, 8)}`;
}

export function getTerminalBrowserSession(
  profileId: TerminalBrowserProfileId,
): Electron.Session {
  return electronSession.fromPartition(
    getTerminalBrowserProfileConfig(profileId).partition,
  );
}

export function getTerminalBrowserKey(
  windowIdOrWindow: number | { id: number },
  profileId: TerminalBrowserProfileId,
  tabId: string,
): string {
  const windowId =
    typeof windowIdOrWindow === "number"
      ? windowIdOrWindow
      : windowIdOrWindow.id;
  return `${windowId}:${profileId}:${tabId}`;
}

export function getTerminalBrowserWorkspaceKey(
  windowIdOrWindow: number | { id: number },
  profileId: TerminalBrowserProfileId,
): string {
  const windowId =
    typeof windowIdOrWindow === "number"
      ? windowIdOrWindow
      : windowIdOrWindow.id;
  return `${windowId}:${profileId}`;
}

export function findTerminalBrowserEntryForWindow(
  windowIdOrWindow: number | { id: number },
  tabId: string,
): { key: string; entry: TerminalBrowserEntry } | null {
  const windowId =
    typeof windowIdOrWindow === "number"
      ? windowIdOrWindow
      : windowIdOrWindow.id;
  for (const [key, entry] of terminalBrowserRuntime.entries) {
    if (entry.windowId === windowId && key.endsWith(`:${tabId}`)) {
      return { key, entry };
    }
  }
  return null;
}
