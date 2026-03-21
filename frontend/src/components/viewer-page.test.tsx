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
    render(<ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />);

    expect(screen.queryByRole("button", { name: "Open DevTools" })).toBeNull();
  });

  it("renders devtools button and sends open command when clicked", async () => {
    useViewerConnectionMock.mockReturnValue(
      buildViewerConnectionState({ devtoolsEnabled: true }),
    );

    render(<ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />);

    fireEvent.click(screen.getByRole("button", { name: "Open DevTools" }));

    expect(sendInput).toHaveBeenCalledWith({
      type: "devtools",
      action: "open",
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

    render(<ViewerPage apiBase="http://localhost:5000" sessionId="s-1" token="t" />);

    const frame = screen.getByTitle("DevTools");
    expect(frame).toBeInTheDocument();
    expect(frame).toHaveAttribute(
      "src",
      "http://localhost:5000/devtools?sessionId=s-1&token=t&tabId=tab-1",
    );
  });
});
