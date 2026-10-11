import type { PushBadgeReaderAccess, PushEnvironment } from "../push-notifications";

/** Absolute count of terminals whose completion has not been acknowledged. */
export interface TerminalUnreadSnapshot {
  hostId: string;
  revision: number;
  count: number;
}

/** Main-renderer supplied credentials; retained only in Electron main memory. */
export interface TerminalBadgeConnection {
  id: string;
  url: string;
  token: string | null;
}

export interface TerminalBadgeGatewayTarget {
  gatewayURL: string;
  targetId: string;
  subscriptionId: string;
  environment: PushEnvironment;
}

export interface TerminalBadgeGatewayTargets {
  targets: TerminalBadgeGatewayTarget[];
}

export interface TerminalBadgeGatewayAccess extends PushBadgeReaderAccess {
  gatewayURL: string;
}

/** Safe to expose to the renderer: contains no connection or gateway credentials. */
export interface TerminalBadgeStatus {
  state: "discovering" | "ready" | "stale" | "unavailable" | "conflict";
  count: number | null;
  lastSyncedAt: string | null;
  reason: string | null;
}
