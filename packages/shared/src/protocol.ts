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
      deltaX: number;
      deltaY: number;
    };

export type ServerEventMessage =
  | {
      type: "connected";
      sessionId: string;
    }
  | {
      type: "ack";
      eventType: ClientInputMessage["type"];
    }
  | {
      type: "error";
      message: string;
    };
