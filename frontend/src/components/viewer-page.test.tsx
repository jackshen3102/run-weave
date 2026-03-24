import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerPage } from "./viewer-page";

const sendInput = vi.fn();

function buildViewerConnectionState(overrides?: {
  devtoolsEnabled?: boolean;
  devtoolsByTabId?: Record<string, boolean>;
}) {
  return {
    status: "connected" as const,
    error: null,
    sentCount: 0,
    ackCount: 0,
    tabs: [
      {
        id: "tab-1",
        title: "Tab 1",
        url: "https://example.com",
        active: true,
      },
    ],
    navigationByTabId: {
      "tab-1": {
        tabId: "tab-1",
        url: "https://example.com",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      },
    },
    devtoolsEnabled: overrides?.devtoolsEnabled ?? false,
    devtoolsByTabId: overrides?.devtoolsByTabId ?? {},
    sendInput,
    reconnect: vi.fn(),
  };
}

const useViewerConnectionMock = vi.fn(() => buildViewerConnectionState());

vi.mock("../features/viewer/use-viewer-connection", () => ({
  useViewerConnection: () => useViewerConnectionMock(),
}));

vi.mock("../features/viewer/use-viewer-input", () => ({
  useViewerInput: () => ({
    onMouseDown: vi.fn(),
    onMouseMove: vi.fn(),
    onWheel: vi.fn(),
    onContextMenu: vi.fn(),
    onMouseLeave: vi.fn(),
    onKeyDown: vi.fn(),
  }),
}));

describe("ViewerPage devtools controls", () => {
  beforeEach(() => {
    sendInput.mockReset();
    useViewerConnectionMock.mockReset();
    useViewerConnectionMock.mockReturnValue(buildViewerConnectionState());
  });

  it("does not render devtools button when feature is disabled", () => {
    render(
      <ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />,
    );

    expect(screen.queryByRole("button", { name: "Inspect" })).toBeNull();
  });

  it("renders devtools button and sends open command when clicked", async () => {
    useViewerConnectionMock.mockReturnValue(
      buildViewerConnectionState({ devtoolsEnabled: true }),
    );

    render(
      <ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));

    expect(sendInput).toHaveBeenCalledWith({
      type: "devtools",
      action: "open",
      tabId: "tab-1",
    });
  });

  it("keeps address bar hidden until expanded from more menu", () => {
    render(
      <ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />,
    );

    expect(screen.queryByTestId("navigation-bar")).toBeNull();

    const moreActionsButton = screen.getAllByRole("button", {
      name: "More actions",
    })[0];

    expect(moreActionsButton).toBeDefined();
    fireEvent.click(moreActionsButton!);
    fireEvent.click(screen.getByRole("button", { name: "Show address bar" }));

    expect(screen.getByTestId("navigation-bar")).toBeInTheDocument();
  });

  it("sends close tab command from more menu", () => {
    render(
      <ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />,
    );

    const moreActionsButton = screen.getAllByRole("button", {
      name: "More actions",
    })[0];

    fireEvent.click(moreActionsButton!);
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));

    expect(sendInput).toHaveBeenCalledWith({
      type: "tab",
      action: "close",
      tabId: "tab-1",
    });
  });

  it("renders devtools iframe when opened", () => {
    useViewerConnectionMock.mockReturnValue(
      buildViewerConnectionState({
        devtoolsEnabled: true,
        devtoolsByTabId: { "tab-1": true },
      }),
    );

    render(
      <ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />,
    );

    expect(screen.getByRole("button", { name: "Page" })).toBeInTheDocument();
    const frame = screen.getByTitle("DevTools");
    expect(frame).toBeInTheDocument();
    expect(frame).toHaveAttribute(
      "src",
      "http://localhost:5000/devtools?sessionId=s-1&token=t&tabId=tab-1",
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("blocks browser back/forward while viewer page is mounted", () => {
    window.history.replaceState(null, "", "/viewer/s-1");
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = render(
      <ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />,
    );

    expect(pushStateSpy).toHaveBeenCalled();

    const popstateHandler = addEventListenerSpy.mock.calls.find(
      ([eventName]) => eventName === "popstate",
    )?.[1] as EventListener;

    expect(popstateHandler).toBeTypeOf("function");

    const callCountBeforePopstate = pushStateSpy.mock.calls.length;
    popstateHandler(new PopStateEvent("popstate"));
    expect(pushStateSpy.mock.calls.length).toBe(callCountBeforePopstate + 1);

    expect(removeEventListenerSpy).not.toHaveBeenCalledWith(
      "popstate",
      popstateHandler,
    );

    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "popstate",
      popstateHandler,
    );
  });
});
