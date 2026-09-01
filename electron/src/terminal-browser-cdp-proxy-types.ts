import type { WebSocket } from "ws";
import type { CdpSessionManager } from "./terminal-browser-cdp-proxy-session.js";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

export interface CdpProxyOptions {
  host: string;
  port: number;
  identity?: {
    instanceId: string | null;
    devSessionId: string | null;
    sourceRevision: string;
    pid: number;
  };
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
  scopedProfileId: TerminalBrowserProfileId;
  scopedGroupId: string | null;
  browserSessionIds: Set<string>;
  discoveryEnabled: boolean;
  autoAttachEnabled: boolean;
  waitForDebuggerOnStart: boolean;
  isAlive: boolean;
}
