import type { NavigationState, ViewerTab } from "@browser-viewer/shared";

export type ViewerConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface ViewerConnectionState {
  status: ViewerConnectionStatus;
  error: string | null;
  sentCount: number;
  ackCount: number;
  tabs: ViewerTab[];
  navigationByTabId: Record<string, NavigationState>;
  devtoolsEnabled: boolean;
  devtoolsByTabId: Record<string, boolean>;
}

export type ViewerConnectionAction =
  | { type: "connection/opened" }
  | { type: "connection/status"; status: ViewerConnectionStatus }
  | { type: "connection/error"; error: string | null }
  | { type: "input/sent" }
  | { type: "message/ack" }
  | { type: "message/tabs"; tabs: ViewerTab[] }
  | { type: "message/navigation-state"; navigation: NavigationState }
  | { type: "message/devtools-capability"; enabled: boolean }
  | { type: "message/devtools-state"; tabId: string; opened: boolean };

export const initialViewerConnectionState: ViewerConnectionState = {
  status: "connecting",
  error: null,
  sentCount: 0,
  ackCount: 0,
  tabs: [],
  navigationByTabId: {},
  devtoolsEnabled: false,
  devtoolsByTabId: {},
};

function hasTab(tabs: ViewerTab[], tabId: string): boolean {
  return tabs.some((tab) => tab.id === tabId);
}

function pruneByTabIds<T>(
  record: Record<string, T>,
  tabs: ViewerTab[],
): Record<string, T> {
  const nextTabIds = new Set(tabs.map((tab) => tab.id));
  const next: Record<string, T> = {};

  for (const [tabId, value] of Object.entries(record)) {
    if (nextTabIds.has(tabId)) {
      next[tabId] = value;
    }
  }

  return next;
}

export function viewerConnectionReducer(
  state: ViewerConnectionState,
  action: ViewerConnectionAction,
): ViewerConnectionState {
  switch (action.type) {
    case "connection/opened":
      return {
        ...state,
        status: "connected",
        error: null,
      };
    case "connection/status":
      return {
        ...state,
        status: action.status,
      };
    case "connection/error":
      return {
        ...state,
        error: action.error,
      };
    case "input/sent":
      return {
        ...state,
        sentCount: state.sentCount + 1,
      };
    case "message/ack":
      return {
        ...state,
        ackCount: state.ackCount + 1,
      };
    case "message/tabs":
      return {
        ...state,
        tabs: action.tabs,
        navigationByTabId: pruneByTabIds(state.navigationByTabId, action.tabs),
        devtoolsByTabId: pruneByTabIds(state.devtoolsByTabId, action.tabs),
      };
    case "message/navigation-state": {
      if (!hasTab(state.tabs, action.navigation.tabId)) {
        return state;
      }

      return {
        ...state,
        navigationByTabId: {
          ...state.navigationByTabId,
          [action.navigation.tabId]: action.navigation,
        },
      };
    }
    case "message/devtools-capability":
      return {
        ...state,
        devtoolsEnabled: action.enabled,
      };
    case "message/devtools-state": {
      if (!hasTab(state.tabs, action.tabId)) {
        return state;
      }

      return {
        ...state,
        devtoolsByTabId: {
          ...state.devtoolsByTabId,
          [action.tabId]: action.opened,
        },
      };
    }
    default:
      return state;
  }
}
