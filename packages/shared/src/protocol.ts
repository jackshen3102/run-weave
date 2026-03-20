export interface CreateSessionRequest {
  url: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  viewerUrl: string;
}

export interface SessionStatusResponse {
  sessionId: string;
  connected: boolean;
  targetUrl: string;
  createdAt: string;
}

export interface ViewerTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface NavigationState {
  tabId: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type ClientInputMessage =
  | {
      type: "mouse";
      action: "click" | "move";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
    }
  | {
      type: "keyboard";
      key: string;
      modifiers?: string[];
    }
  | {
      type: "scroll";
      x?: number;
      y?: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      type: "tab";
      action: "switch";
      tabId: string;
    }
  | {
      type: "navigation";
      action: "goto";
      tabId: string;
      url: string;
    }
  | {
      type: "navigation";
      action: "back" | "forward" | "reload" | "stop";
      tabId: string;
    };

export type ServerEventMessage =
  | {
      type: "connected";
      sessionId: string;
    }
  | {
      type: "cursor";
      cursor: string;
    }
  | {
      type: "ack";
      eventType: ClientInputMessage["type"];
    }
  | {
      type: "tabs";
      tabs: ViewerTab[];
    }
  | {
      type: "navigation-state";
      state: NavigationState;
    }
  | {
      type: "error";
      message: string;
    };
