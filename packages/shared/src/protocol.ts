export type SessionHeaders = Record<string, string>;

export type SessionSourceType = "launch" | "connect-cdp";

export interface LaunchSessionSource {
  type: "launch";
  proxyEnabled?: boolean;
  headers?: SessionHeaders;
}

export interface ConnectCdpSessionSource {
  type: "connect-cdp";
  endpoint: string;
}

export type CreateSessionSource = LaunchSessionSource | ConnectCdpSessionSource;

export interface CreateSessionRequest {
  name?: string;
  url?: string;
  source?: CreateSessionSource;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  sessionId: string;
}

export interface RefreshSessionRequest {
  refreshToken: string;
}

export interface RefreshSessionResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  sessionId: string;
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  viewerUrl: string;
}

export interface UpdateSessionRequest {
  name: string;
}

export interface CreateDevtoolsTicketRequest {
  tabId: string;
}

export interface CreateDevtoolsTicketResponse {
  ticket: string;
  expiresIn: number;
}

export interface CreateViewerWsTicketResponse {
  ticket: string;
  expiresIn: number;
}

export interface SessionStatusResponse {
  sessionId: string;
  connected: boolean;
  name: string;
  proxyEnabled: boolean;
  sourceType: SessionSourceType;
  cdpEndpoint?: string;
  headers: SessionHeaders;
  createdAt: string;
}

export interface SessionListItem {
  sessionId: string;
  connected: boolean;
  name: string;
  proxyEnabled: boolean;
  sourceType: SessionSourceType;
  cdpEndpoint?: string;
  headers: SessionHeaders;
  createdAt: string;
  lastActivityAt: string;
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
      type: "clipboard";
      action: "paste";
      text: string;
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
      type: "tab";
      action: "close";
      tabId: string;
    }
  | {
      type: "tab";
      action: "create";
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
    }
  | {
      type: "devtools";
      action: "open" | "close";
      tabId: string;
    };

export type ServerEventMessage =
  | {
      type: "connected";
      sessionId: string;
    }
  | {
      type: "devtools-capability";
      enabled: boolean;
    }
  | {
      type: "devtools-state";
      tabId: string;
      opened: boolean;
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
      type: "clipboard";
      action: "copy";
      text: string;
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
