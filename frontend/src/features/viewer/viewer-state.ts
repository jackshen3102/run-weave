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
}

export type ViewerConnectionAction =
  | { type: "connection/opened" }
  | { type: "connection/status"; status: ViewerConnectionStatus }
  | { type: "connection/error"; error: string | null }
  | { type: "input/sent" }
  | { type: "message/ack" }
  | { type: "message/tabs"; tabs: ViewerTab[] }
  | { type: "message/navigation-state"; navigation: NavigationState };

export const initialViewerConnectionState: ViewerConnectionState = {
  status: "connecting",
  error: null,
  sentCount: 0,
  ackCount: 0,
  tabs: [],
  navigationByTabId: {},
};

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
    case "message/tabs": {
      const nextTabIds = new Set(action.tabs.map((tab) => tab.id));
      const nextNavigationByTabId: Record<string, NavigationState> = {};

      for (const [tabId, navigation] of Object.entries(
        state.navigationByTabId,
      )) {
        if (nextTabIds.has(tabId)) {
          nextNavigationByTabId[tabId] = navigation;
        }
      }

      return {
        ...state,
        tabs: action.tabs,
        navigationByTabId: nextNavigationByTabId,
      };
    }
    case "message/navigation-state": {
      const tabExists = state.tabs.some(
        (tab) => tab.id === action.navigation.tabId,
      );
      if (!tabExists) {
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
    default:
      return state;
  }
}
