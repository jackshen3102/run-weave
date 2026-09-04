import type { TerminalBrowserDeviceState } from "./device";
import type { TerminalBrowserProfileId } from "./profile";
import type { TerminalBrowserMinimumViewportWidth } from "./minimum-width";

export interface TerminalBrowserSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface TerminalBrowserUpdate extends TerminalBrowserSnapshot {
  profileId: TerminalBrowserProfileId;
  tabId: string;
  browserGroupId: string;
  loading: boolean;
  cdpProxyAttached: boolean;
  mcpActivityUntil: number | null;
  devtoolsOpen: boolean;
  deviceState: TerminalBrowserDeviceState;
  displayScale: number;
  minimumViewportWidth: TerminalBrowserMinimumViewportWidth;
  faviconDataUrl: string | null;
  navigationError: string | null;
}

export interface TerminalBrowserTabSnapshot extends TerminalBrowserUpdate {
  active: boolean;
}

export type TerminalBrowserGroupNameOrigin =
  | "placeholder"
  | "automatic"
  | "user";

export interface TerminalBrowserGroupSnapshot {
  id: string;
  name: string;
  nameOrigin: TerminalBrowserGroupNameOrigin;
  tabIds: string[];
}

export interface TerminalBrowserWorkspaceSnapshot {
  profileId: TerminalBrowserProfileId;
  revision: number;
  activeTabId: string;
  groups: TerminalBrowserGroupSnapshot[];
  tabs: TerminalBrowserTabSnapshot[];
}

export type TerminalBrowserCreateTabRequest =
  | {
      profileId: TerminalBrowserProfileId;
      placement: "current-group";
      groupId: string;
      openerTabId: string;
      url?: string;
    }
  | {
      profileId: TerminalBrowserProfileId;
      placement: "new-group";
      url?: string;
    };

export type TerminalBrowserStateChangedEvent =
  | {
      kind: "workspace";
      revision: number;
      workspace: TerminalBrowserWorkspaceSnapshot;
    }
  | {
      kind: "tab";
      revision: number;
      tab: TerminalBrowserUpdate;
    };
