import { describe, expect, it } from "vitest";
import {
  initialViewerConnectionState,
  viewerConnectionReducer,
} from "./viewer-state";

describe("viewerConnectionReducer", () => {
  it("assumes devtools are available until the server says otherwise", () => {
    expect(initialViewerConnectionState.devtoolsEnabled).toBe(true);
  });

  it("updates tabs and prunes stale navigation states", () => {
    const stateWithNav = {
      ...initialViewerConnectionState,
      navigationByTabId: {
        keep: {
          tabId: "keep",
          url: "https://a.example",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
        },
        drop: {
          tabId: "drop",
          url: "https://b.example",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
        },
      },
    };

    const nextState = viewerConnectionReducer(stateWithNav, {
      type: "message/tabs",
      tabs: [
        { id: "keep", title: "Keep", url: "https://a.example", active: true },
      ],
    });

    expect(nextState.tabs).toHaveLength(1);
    expect(nextState.navigationByTabId).toEqual({
      keep: stateWithNav.navigationByTabId.keep,
    });
  });

  it("ignores navigation state for unknown tabs", () => {
    const nextState = viewerConnectionReducer(initialViewerConnectionState, {
      type: "message/navigation-state",
      navigation: {
        tabId: "unknown",
        url: "https://unknown.example",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      },
    });

    expect(nextState).toBe(initialViewerConnectionState);
  });

  it("records navigation state for known tab", () => {
    const stateWithTab = viewerConnectionReducer(initialViewerConnectionState, {
      type: "message/tabs",
      tabs: [
        {
          id: "known",
          title: "Known",
          url: "https://known.example",
          active: true,
        },
      ],
    });

    const nextState = viewerConnectionReducer(stateWithTab, {
      type: "message/navigation-state",
      navigation: {
        tabId: "known",
        url: "https://known.example/page",
        isLoading: true,
        canGoBack: true,
        canGoForward: false,
      },
    });

    expect(nextState.navigationByTabId.known?.url).toBe(
      "https://known.example/page",
    );
    expect(nextState.navigationByTabId.known?.isLoading).toBe(true);
  });

  it("stores devtools capability", () => {
    const nextState = viewerConnectionReducer(initialViewerConnectionState, {
      type: "message/devtools-capability",
      enabled: true,
    });

    expect(nextState.devtoolsEnabled).toBe(true);
  });

  it("stores and prunes devtools state by tab", () => {
    const withTabs = viewerConnectionReducer(initialViewerConnectionState, {
      type: "message/tabs",
      tabs: [
        {
          id: "tab-1",
          title: "Tab 1",
          url: "https://example.com",
          active: true,
        },
      ],
    });

    const withDevtoolsOpen = viewerConnectionReducer(withTabs, {
      type: "message/devtools-state",
      tabId: "tab-1",
      opened: true,
    });

    const pruned = viewerConnectionReducer(withDevtoolsOpen, {
      type: "message/tabs",
      tabs: [],
    });

    expect(withDevtoolsOpen.devtoolsByTabId["tab-1"]).toBe(true);
    expect(pruned.devtoolsByTabId).toEqual({});
  });

  it("ignores devtools state for unknown tabs", () => {
    const nextState = viewerConnectionReducer(initialViewerConnectionState, {
      type: "message/devtools-state",
      tabId: "unknown",
      opened: true,
    });

    expect(nextState).toBe(initialViewerConnectionState);
  });

  it("increments ack and sent counters", () => {
    const afterAck = viewerConnectionReducer(initialViewerConnectionState, {
      type: "message/ack",
    });
    const afterSent = viewerConnectionReducer(afterAck, {
      type: "input/sent",
    });

    expect(afterAck.ackCount).toBe(1);
    expect(afterSent.sentCount).toBe(1);
  });

  it("sets error and clears it when connection opens", () => {
    const errored = viewerConnectionReducer(initialViewerConnectionState, {
      type: "connection/error",
      error: "boom",
    });
    const opened = viewerConnectionReducer(errored, {
      type: "connection/opened",
    });

    expect(errored.error).toBe("boom");
    expect(opened.status).toBe("connected");
    expect(opened.error).toBeNull();
  });

  it("stores collaboration state updates", () => {
    const nextState = viewerConnectionReducer(initialViewerConnectionState, {
      type: "message/collaboration-state",
      collaboration: {
        controlOwner: "ai",
        aiStatus: "running",
        collaborationTabId: "tab-1",
        aiBridgeIssuedAt: "2026-04-08T10:00:00.000Z",
        aiBridgeExpiresAt: "2026-04-08T10:01:00.000Z",
        aiLastAction: "Page.navigate",
        aiLastError: null,
      },
    });

    expect(nextState.collaboration.controlOwner).toBe("ai");
    expect(nextState.collaboration.aiStatus).toBe("running");
    expect(nextState.collaboration.collaborationTabId).toBe("tab-1");
  });
});
