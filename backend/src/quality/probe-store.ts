import type {
  QualityProbeEvent,
  SessionQualityResponse,
  SessionQualitySnapshot,
} from "@browser-viewer/shared";

interface QualityErrorRecord {
  code: string;
  message: string;
  at: string;
}

interface SessionProbeRecord {
  snapshot: SessionQualitySnapshot;
  timeline: QualityProbeEvent[];
}

function createInitialSnapshot(sessionId: string): SessionQualitySnapshot {
  return {
    sessionId,
    journeyStatus: "running",
    viewerConnected: false,
    activeTabId: null,
    tabCount: 0,
    reconnectCount: 0,
    firstFrameAt: null,
    lastAckAt: null,
    lastNavigationRequestedAt: null,
    lastNavigationSettledAt: null,
    milestones: {
      tabsInitialized: false,
      viewerConnected: false,
      firstFrame: false,
      inputAckWorking: false,
      navigationWorking: false,
      reconnectRecovered: false,
    },
    recentErrors: [],
  };
}

function cloneRecord(record: SessionProbeRecord): SessionQualityResponse {
  return {
    snapshot: {
      ...record.snapshot,
      milestones: {
        ...record.snapshot.milestones,
      },
      recentErrors: record.snapshot.recentErrors.map((error) => ({ ...error })),
    },
    timeline: record.timeline.map((event) => ({
      ...event,
      details: event.details ? { ...event.details } : undefined,
    })),
  };
}

export class QualityProbeStore {
  private readonly sessions = new Map<string, SessionProbeRecord>();

  createSession(sessionId: string): void {
    const record: SessionProbeRecord = {
      snapshot: createInitialSnapshot(sessionId),
      timeline: [],
    };
    this.sessions.set(sessionId, record);
    this.pushEvent(sessionId, {
      type: "session.created",
      at: new Date().toISOString(),
    });
  }

  destroySession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }

    this.pushEvent(sessionId, {
      type: "session.destroyed",
      at: new Date().toISOString(),
    });
  }

  markViewerConnected(sessionId: string, connected: boolean): void {
    const record = this.ensureRecord(sessionId);
    const wasConnected = record.snapshot.viewerConnected;
    record.snapshot.viewerConnected = connected;
    record.snapshot.milestones.viewerConnected = connected;
    const now = new Date().toISOString();

    if (!connected && wasConnected) {
      record.snapshot.reconnectCount += 1;
      this.pushEvent(sessionId, {
        type: "viewer.ws.reconnect-started",
        at: now,
        details: {
          reconnectCount: record.snapshot.reconnectCount,
        },
      });
    }

    if (connected && record.snapshot.reconnectCount > 0) {
      record.snapshot.milestones.reconnectRecovered = true;
      this.pushEvent(sessionId, {
        type: "viewer.ws.reconnect-recovered",
        at: now,
        details: {
          reconnectCount: record.snapshot.reconnectCount,
        },
      });
    }

    this.updateJourneyStatus(record.snapshot);
    this.pushEvent(sessionId, {
      type: connected ? "viewer.ws.connected" : "viewer.ws.disconnected",
      at: now,
    });
  }

  updateTabState(
    sessionId: string,
    params: { activeTabId: string | null; tabCount: number },
  ): void {
    const record = this.ensureRecord(sessionId);
    record.snapshot.activeTabId = params.activeTabId;
    record.snapshot.tabCount = params.tabCount;
    record.snapshot.milestones.tabsInitialized = params.tabCount > 0;
    this.updateJourneyStatus(record.snapshot);
    this.pushEvent(sessionId, {
      type: "viewer.tabs.updated",
      at: new Date().toISOString(),
      details: {
        activeTabId: params.activeTabId,
        tabCount: params.tabCount,
      },
    });
  }

  markFirstFrame(sessionId: string): void {
    const record = this.ensureRecord(sessionId);
    if (record.snapshot.firstFrameAt) {
      return;
    }

    const now = new Date().toISOString();
    record.snapshot.firstFrameAt = now;
    record.snapshot.milestones.firstFrame = true;
    this.updateJourneyStatus(record.snapshot);
    this.pushEvent(sessionId, {
      type: "viewer.frame.first",
      at: now,
    });
  }

  markInputAck(sessionId: string, eventType: string): void {
    const record = this.ensureRecord(sessionId);
    const now = new Date().toISOString();
    record.snapshot.lastAckAt = now;
    record.snapshot.milestones.inputAckWorking = true;
    this.updateJourneyStatus(record.snapshot);
    this.pushEvent(sessionId, {
      type: "viewer.input.acked",
      at: now,
      details: {
        eventType,
      },
    });
  }

  markNavigationRequested(
    sessionId: string,
    params: { tabId: string; url: string | null },
  ): void {
    const record = this.ensureRecord(sessionId);
    const now = new Date().toISOString();
    record.snapshot.lastNavigationRequestedAt = now;
    this.pushEvent(sessionId, {
      type: "viewer.navigation.requested",
      at: now,
      details: {
        tabId: params.tabId,
        url: params.url,
      },
    });
  }

  markNavigationSettled(
    sessionId: string,
    params: { tabId: string; url: string | null },
  ): void {
    const record = this.ensureRecord(sessionId);
    const now = new Date().toISOString();
    record.snapshot.lastNavigationSettledAt = now;
    record.snapshot.milestones.navigationWorking = true;
    this.updateJourneyStatus(record.snapshot);
    this.pushEvent(sessionId, {
      type: "viewer.navigation.settled",
      at: now,
      details: {
        tabId: params.tabId,
        url: params.url,
      },
    });
  }

  recordError(sessionId: string, code: string, message: string): void {
    const record = this.ensureRecord(sessionId);
    const errorRecord: QualityErrorRecord = {
      code,
      message,
      at: new Date().toISOString(),
    };
    record.snapshot.recentErrors = [
      ...record.snapshot.recentErrors,
      errorRecord,
    ].slice(-10);
    record.snapshot.journeyStatus = "failed";
    this.pushEvent(sessionId, {
      type: "viewer.error",
      at: errorRecord.at,
      details: {
        code,
        message,
      },
    });
  }

  getSession(sessionId: string): SessionQualityResponse | null {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return null;
    }

    return cloneRecord(record);
  }

  resetSession(sessionId: string): boolean {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return false;
    }

    const nextRecord: SessionProbeRecord = {
      snapshot: createInitialSnapshot(sessionId),
      timeline: [],
    };
    this.sessions.set(sessionId, nextRecord);
    this.pushEvent(sessionId, {
      type: "session.created",
      at: new Date().toISOString(),
      details: { reset: true },
    });
    return true;
  }

  private ensureRecord(sessionId: string): SessionProbeRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const nextRecord: SessionProbeRecord = {
      snapshot: createInitialSnapshot(sessionId),
      timeline: [],
    };
    this.sessions.set(sessionId, nextRecord);
    return nextRecord;
  }

  private pushEvent(sessionId: string, event: QualityProbeEvent): void {
    const record = this.ensureRecord(sessionId);
    record.timeline.push(event);
    if (record.timeline.length > 100) {
      record.timeline.splice(0, record.timeline.length - 100);
    }
  }

  private updateJourneyStatus(snapshot: SessionQualitySnapshot): void {
    if (snapshot.recentErrors.length > 0) {
      snapshot.journeyStatus = "failed";
      return;
    }

    if (
      snapshot.milestones.tabsInitialized &&
      snapshot.milestones.viewerConnected &&
      snapshot.milestones.firstFrame &&
      snapshot.milestones.inputAckWorking &&
      snapshot.milestones.navigationWorking
    ) {
      snapshot.journeyStatus = "healthy";
      return;
    }

    if (
      snapshot.milestones.viewerConnected ||
      snapshot.milestones.firstFrame ||
      snapshot.milestones.inputAckWorking
    ) {
      snapshot.journeyStatus = "degraded";
      return;
    }

    snapshot.journeyStatus = "running";
  }
}
