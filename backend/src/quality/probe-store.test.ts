import { describe, expect, it } from "vitest";
import { QualityProbeStore } from "./probe-store";

describe("QualityProbeStore", () => {
  it("tracks the core M1 milestones for a session", () => {
    const store = new QualityProbeStore();

    store.createSession("session-1");
    store.updateTabState("session-1", {
      activeTabId: "tab-1",
      tabCount: 1,
    });
    store.markViewerConnected("session-1", true);
    store.markFirstFrame("session-1");
    store.markNavigationSettled("session-1", {
      tabId: "tab-1",
      url: "https://example.com",
    });
    store.markInputAck("session-1", "mouse");

    const quality = store.getSession("session-1");

    expect(quality).not.toBeNull();
    expect(quality?.snapshot.viewerConnected).toBe(true);
    expect(quality?.snapshot.milestones.viewerConnected).toBe(true);
    expect(quality?.snapshot.milestones.firstFrame).toBe(true);
    expect(quality?.snapshot.milestones.inputAckWorking).toBe(true);
    expect(quality?.snapshot.journeyStatus).toBe("healthy");
    expect(quality?.timeline.map((event) => event.type)).toEqual([
      "session.created",
      "viewer.tabs.updated",
      "viewer.ws.connected",
      "viewer.frame.first",
      "viewer.navigation.settled",
      "viewer.input.acked",
    ]);
  });

  it("tracks tab and navigation milestones for M2", () => {
    const store = new QualityProbeStore();

    store.createSession("session-m2");
    store.updateTabState("session-m2", {
      activeTabId: "tab-2",
      tabCount: 2,
    });
    store.markNavigationRequested("session-m2", {
      tabId: "tab-2",
      url: "http://127.0.0.1/test/navigation-chain",
    });
    store.markNavigationSettled("session-m2", {
      tabId: "tab-2",
      url: "http://127.0.0.1/test/navigation-final",
    });

    const quality = store.getSession("session-m2");

    expect(quality?.snapshot.activeTabId).toBe("tab-2");
    expect(quality?.snapshot.tabCount).toBe(2);
    expect(quality?.snapshot.milestones.tabsInitialized).toBe(true);
    expect(quality?.snapshot.milestones.navigationWorking).toBe(true);
    expect(quality?.snapshot.lastNavigationRequestedAt).toBeTruthy();
    expect(quality?.snapshot.lastNavigationSettledAt).toBeTruthy();
    expect(quality?.timeline.map((event) => event.type)).toEqual([
      "session.created",
      "viewer.tabs.updated",
      "viewer.navigation.requested",
      "viewer.navigation.settled",
    ]);
  });

  it("tracks reconnect recovery", () => {
    const store = new QualityProbeStore();

    store.createSession("session-reconnect");
    store.updateTabState("session-reconnect", {
      activeTabId: "tab-1",
      tabCount: 1,
    });
    store.markViewerConnected("session-reconnect", true);
    store.markViewerConnected("session-reconnect", false);
    store.markViewerConnected("session-reconnect", true);

    const quality = store.getSession("session-reconnect");

    expect(quality?.snapshot.reconnectCount).toBe(1);
    expect(quality?.snapshot.milestones.reconnectRecovered).toBe(true);
    expect(quality?.timeline.map((event) => event.type)).toEqual([
      "session.created",
      "viewer.tabs.updated",
      "viewer.ws.connected",
      "viewer.ws.reconnect-started",
      "viewer.ws.disconnected",
      "viewer.ws.reconnect-recovered",
      "viewer.ws.connected",
    ]);
  });

  it("marks the journey as failed when an error is recorded", () => {
    const store = new QualityProbeStore();

    store.createSession("session-2");
    store.recordError("session-2", "ws-init", "failed to initialize tabs");

    const quality = store.getSession("session-2");

    expect(quality?.snapshot.journeyStatus).toBe("failed");
    expect(quality?.snapshot.recentErrors).toEqual([
      expect.objectContaining({
        code: "ws-init",
        message: "failed to initialize tabs",
      }),
    ]);
  });
});
