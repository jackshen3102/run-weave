import { describe, expect, it } from "vitest";
import { getViewerSurfaceState } from "./viewer-surface";

describe("getViewerSurfaceState", () => {
  it("prioritizes connection status over page loading", () => {
    expect(
      getViewerSurfaceState({
        activeTabId: "tab-1",
        status: "reconnecting",
        isLoading: true,
        error: null,
      }),
    ).toEqual({
      visible: true,
      presentation: "overlay",
      blocksInput: true,
      title: "Reconnecting to browser",
      detail: "Trying to restore the live page stream.",
      tone: "warning",
      action: null,
    });
  });

  it("shows a loading message for active page navigations", () => {
    expect(
      getViewerSurfaceState({
        activeTabId: "tab-1",
        status: "connected",
        isLoading: true,
        error: null,
      }),
    ).toEqual({
      visible: true,
      presentation: "badge",
      blocksInput: false,
      title: "Loading page",
      detail: "Waiting for the next browser frame.",
      tone: "neutral",
      action: null,
    });
  });

  it("stays hidden when the viewer is connected and idle", () => {
    expect(
      getViewerSurfaceState({
        activeTabId: "tab-1",
        status: "connected",
        isLoading: false,
        error: null,
      }),
    ).toEqual({
      visible: false,
      presentation: "hidden",
      blocksInput: false,
      title: "",
      detail: null,
      tone: "neutral",
      action: null,
    });
  });

  it("marks closed connections as blocking and reconnectable", () => {
    expect(
      getViewerSurfaceState({
        activeTabId: "tab-1",
        status: "closed",
        isLoading: false,
        error: "socket closed",
      }),
    ).toEqual({
      visible: true,
      presentation: "overlay",
      blocksInput: true,
      title: "Viewer disconnected",
      detail: "socket closed",
      tone: "warning",
      action: "reconnect",
    });
  });
});
