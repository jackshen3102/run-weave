import type { WebSocket } from "ws";
import type { CdpSessionManager } from "./terminal-browser-cdp-proxy-session.js";

export interface CdpProxyOptions {
  host: string;
  port: number;
}

export interface CdpProxyRuntime {
  endpoint: string;
  port: number;
  host: string;
  stop(): Promise<void>;
}

export interface CdpProxyConnectionState {
  ws: WebSocket;
  sessionManager: CdpSessionManager;
  scopedGroupId: string | null;
  browserSessionIds: Set<string>;
  discoveryEnabled: boolean;
  autoAttachEnabled: boolean;
  waitForDebuggerOnStart: boolean;
  isAlive: boolean;
}
