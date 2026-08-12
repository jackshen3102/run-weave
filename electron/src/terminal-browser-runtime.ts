import {
  session as electronSession,
  type WebContents,
  type WebContentsView,
} from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TerminalBrowserUpdate } from "@runweave/shared/desktop-bridge";
import type { TerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import type {
  TerminalBrowserGroupNameOrigin,
} from "@runweave/shared/terminal-browser-workspace";

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
  view: WebContentsView;
  attached: boolean;
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
  revision: number;
  groups: TerminalBrowserGroupRecord[];
}

export interface TerminalBrowserCdpTarget {
  key: string;
  targetId: string;
  browserGroupId: string;
  windowId: number;
  active: boolean;
  lastActiveAt: number;
  url: string;
  title: string;
  webContents: WebContents;
}

export const TERMINAL_BROWSER_SESSION_PARTITION =
  "persist:runweave-terminal-browser";

export const terminalBrowserRuntime = {
  entries: new Map<string, TerminalBrowserEntry>(),
  attachedByWindowId: new Map<number, string>(),
  workspaceByWindowId: new Map<number, TerminalBrowserWindowWorkspace>(),
  saveTimer: null as NodeJS.Timeout | null,
  persistedStateRestored: false,
  restoringWindows: new Set<number>(),
};

export const terminalBrowserEvents = new EventEmitter();

export function createTerminalBrowserGroupId(): string {
  return `browser-group-${randomUUID().slice(0, 8)}`;
}

export function getTerminalBrowserSession(): Electron.Session {
  return electronSession.fromPartition(TERMINAL_BROWSER_SESSION_PARTITION);
}

export function getTerminalBrowserKey(
  windowIdOrWindow: number | { id: number },
  tabId: string,
): string {
  const windowId =
    typeof windowIdOrWindow === "number"
      ? windowIdOrWindow
      : windowIdOrWindow.id;
  return `${windowId}:${tabId}`;
}
