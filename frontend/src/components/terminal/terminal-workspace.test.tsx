import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionListItem } from "@browser-viewer/shared";
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

describe("TerminalWorkspace", () => {
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

  it("does not auto-create a terminal session on mount", async () => {
    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(listTerminalSessionsMock).toHaveBeenCalled();
    });

    expect(createTerminalSessionMock).not.toHaveBeenCalled();
  });

  it("creates a terminal session from the new button without browser linkage", async () => {
    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    fireEvent.click(screen.getAllByRole("button", { name: "New" })[0]!);

    await waitFor(() => {
      expect(createTerminalSessionMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        {},
      );
    });
  });

  it("reports the current active session after loading sessions", async () => {
    const onActiveSessionChange = vi.fn();
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        name: "shell-2",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T01:00:00.000Z",
      },
    ]);

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        onActiveSessionChange={onActiveSessionChange}
      />,
    );

    await waitFor(() => {
      expect(onActiveSessionChange).toHaveBeenLastCalledWith("terminal-1");
    });
  });

  it("falls back to the first session when the requested session is missing", async () => {
    const onActiveSessionChange = vi.fn();
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        name: "shell-2",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T01:00:00.000Z",
      },
    ]);

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        initialTerminalSessionId="missing-terminal"
        onActiveSessionChange={onActiveSessionChange}
      />,
    );

    await waitFor(() => {
      expect(onActiveSessionChange).toHaveBeenLastCalledWith("terminal-1");
    });
  });

  it("keeps the requested initial session when sessions load later", async () => {
    const onActiveSessionChange = vi.fn();
    let resolveSessions:
      | ((value: TerminalSessionListItem[]) => void)
      | undefined;
    listTerminalSessionsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSessions = resolve as (value: TerminalSessionListItem[]) => void;
      }),
    );

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        initialTerminalSessionId="terminal-2"
        onActiveSessionChange={onActiveSessionChange}
      />,
    );

    resolveSessions?.([
      {
        terminalSessionId: "terminal-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        name: "shell-2",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T01:00:00.000Z",
      },
    ]);

    await waitFor(() => {
      expect(onActiveSessionChange).toHaveBeenLastCalledWith("terminal-2");
    });
  });

  it("does not report a null active session before the initial load resolves", async () => {
    const onActiveSessionChange = vi.fn();
    let resolveSessions:
      | ((value: TerminalSessionListItem[]) => void)
      | undefined;
    listTerminalSessionsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSessions = resolve as (value: TerminalSessionListItem[]) => void;
      }),
    );

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        initialTerminalSessionId="terminal-2"
        onActiveSessionChange={onActiveSessionChange}
      />,
    );

    expect(onActiveSessionChange).not.toHaveBeenCalledWith(null);

    resolveSessions?.([
      {
        terminalSessionId: "terminal-2",
        name: "shell-2",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T01:00:00.000Z",
      },
    ]);

    await waitFor(() => {
      expect(onActiveSessionChange).toHaveBeenLastCalledWith("terminal-2");
    });
  });

  it("does not report missing sessions when the terminal list request fails", async () => {
    const onActiveSessionChange = vi.fn();
    const onNoSessionAvailable = vi.fn();
    listTerminalSessionsMock.mockRejectedValue(new Error("terminal list failed"));

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        initialTerminalSessionId="terminal-2"
        onActiveSessionChange={onActiveSessionChange}
        onNoSessionAvailable={onNoSessionAvailable}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Error: terminal list failed")).toBeInTheDocument();
    });

    expect(onActiveSessionChange).not.toHaveBeenCalled();
    expect(onNoSessionAvailable).not.toHaveBeenCalled();
  });

  it("reports that no terminal is available only after a successful empty load", async () => {
    const onNoSessionAvailable = vi.fn();

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        initialTerminalSessionId="terminal-2"
        onNoSessionAvailable={onNoSessionAvailable}
      />,
    );

    await waitFor(() => {
      expect(onNoSessionAvailable).toHaveBeenCalledTimes(1);
    });
  });

  it("does not reload terminal sessions when only the active tab changes", async () => {
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        name: "shell-2",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T01:00:00.000Z",
      },
    ]);

    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(listTerminalSessionsMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "shell-2" })[0]!);

    expect(listTerminalSessionsMock).toHaveBeenCalledTimes(1);
  });
});
