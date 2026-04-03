import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatestSessionCard } from "./latest-session-card";

describe("LatestSessionCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the empty state when there is no session", () => {
    render(<LatestSessionCard session={null} onEnterSession={vi.fn()} />);

    expect(screen.getByText("Nothing open yet. Start with a page.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("renders session metadata and opens from container and button", () => {
    const onEnterSession = vi.fn();

    render(
      <LatestSessionCard
        session={{
          sessionId: "session-1",
          name: "CDP Playweight",
          createdAt: "2026-04-03T23:59:00.000Z",
          lastActivityAt: "2026-04-04T00:00:00.000Z",
          connected: true,
          proxyEnabled: true,
          sourceType: "connect-cdp",
          cdpEndpoint: "http://127.0.0.1:9222",
          headers: {
            "x-team": "browser",
          },
        }}
        onEnterSession={onEnterSession}
      />,
    );

    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText(/Attach Browser/)).toBeInTheDocument();
    expect(screen.getByText(/Proxy enabled/)).toBeInTheDocument();
    expect(screen.getByText(/1 header/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.keyDown(screen.getByRole("button", { name: /latest session/i }), {
      key: "Enter",
    });

    expect(onEnterSession).toHaveBeenCalledTimes(2);
    expect(onEnterSession).toHaveBeenCalledWith("session-1");
  });
});
