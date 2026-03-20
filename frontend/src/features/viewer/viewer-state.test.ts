import { describe, expect, it } from "vitest";
import {
  initialViewerConnectionState,
  viewerConnectionReducer,
} from "./viewer-state";

describe("viewerConnectionReducer", () => {
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
});
