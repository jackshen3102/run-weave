import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerHeader } from "./viewer-header";

describe("ViewerHeader", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders session metadata and action buttons", () => {
    const onCreateTab = vi.fn();
    const onReconnect = vi.fn();
    const onBack = vi.fn();

    render(
      <ViewerHeader
        sessionId="session-1"
        status="connected"
        canReconnect
        onCreateTab={onCreateTab}
        onReconnect={onReconnect}
        onBack={onBack}
      />,
    );

    expect(screen.getByText("Session: session-1")).toBeInTheDocument();
    expect(screen.getByText("Status: connected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onCreateTab).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("hides the reconnect button when reconnect is unavailable", () => {
    render(
      <ViewerHeader
        sessionId="session-1"
        status="idle"
        canReconnect={false}
        onCreateTab={vi.fn()}
        onReconnect={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});
