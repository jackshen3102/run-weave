import { StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalWorkspace } from "./terminal-workspace";

const listTerminalSessionsMock = vi.fn();
const createTerminalSessionMock = vi.fn();
const deleteTerminalSessionMock = vi.fn();

vi.mock("../../services/terminal", () => ({
  listTerminalSessions: (...args: unknown[]) => listTerminalSessionsMock(...args),
  createTerminalSession: (...args: unknown[]) => createTerminalSessionMock(...args),
  deleteTerminalSession: (...args: unknown[]) => deleteTerminalSessionMock(...args),
}));

vi.mock("./terminal-surface", () => ({
  TerminalSurface: () => <div data-testid="terminal-surface" />,
}));

describe("TerminalWorkspace auto-create", () => {
  beforeEach(() => {
    listTerminalSessionsMock.mockReset();
    createTerminalSessionMock.mockReset();
    deleteTerminalSessionMock.mockReset();

    listTerminalSessionsMock.mockResolvedValue([]);
    createTerminalSessionMock.mockResolvedValue({
      terminalSessionId: "terminal-1",
      terminalUrl: "/terminal/terminal-1",
    });
    deleteTerminalSessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates only one default terminal in StrictMode for the same browser session", async () => {
    const { unmount } = render(
      <StrictMode>
        <TerminalWorkspace
          apiBase="http://localhost:5000"
          token="token-1"
          linkedBrowserSessionId="browser-session-1"
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(createTerminalSessionMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(listTerminalSessionsMock).toHaveBeenCalled();
    });

    expect(createTerminalSessionMock).toHaveBeenCalledWith(
      "http://localhost:5000",
      "token-1",
      {
        linkedBrowserSessionId: "browser-session-1",
      },
    );

    unmount();
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });
  });
});
