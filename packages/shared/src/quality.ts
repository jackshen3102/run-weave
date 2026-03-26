export type QualityMilestoneId =
  | "tabsInitialized"
  | "viewerConnected"
  | "firstFrame"
  | "inputAckWorking"
  | "navigationWorking"
  | "reconnectRecovered";

export type QualityJourneyStatus =
  | "idle"
  | "running"
  | "healthy"
  | "degraded"
  | "failed";

export type QualityProbeEventType =
  | "session.created"
  | "session.destroyed"
  | "viewer.tabs.updated"
  | "viewer.ws.connected"
  | "viewer.ws.disconnected"
  | "viewer.ws.reconnect-started"
  | "viewer.ws.reconnect-recovered"
  | "viewer.frame.first"
  | "viewer.navigation.requested"
  | "viewer.navigation.settled"
  | "viewer.input.acked"
  | "viewer.error";

export interface QualityProbeEvent {
  type: QualityProbeEventType;
  at: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface SessionQualitySnapshot {
  sessionId: string;
  journeyStatus: QualityJourneyStatus;
  viewerConnected: boolean;
  activeTabId: string | null;
  tabCount: number;
  reconnectCount: number;
  firstFrameAt: string | null;
  lastAckAt: string | null;
  lastNavigationRequestedAt: string | null;
  lastNavigationSettledAt: string | null;
  milestones: Record<QualityMilestoneId, boolean>;
  recentErrors: Array<{
    code: string;
    message: string;
    at: string;
  }>;
}

export interface SessionQualityResponse {
  snapshot: SessionQualitySnapshot;
  timeline: QualityProbeEvent[];
}
