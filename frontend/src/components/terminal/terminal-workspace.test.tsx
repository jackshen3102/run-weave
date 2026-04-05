import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionListItem } from "@browser-viewer/shared";
import { TerminalWorkspace } from "./terminal-workspace";

const listTerminalProjectsMock = vi.fn();
const listTerminalSessionsMock = vi.fn();
const createTerminalProjectMock = vi.fn();
const updateTerminalProjectMock = vi.fn();
const deleteTerminalProjectMock = vi.fn();
const createTerminalSessionMock = vi.fn();
const deleteTerminalSessionMock = vi.fn();
const terminalSurfacePropsSpy = vi.fn();

vi.mock("../../services/terminal", () => ({
  listTerminalProjects: (...args: unknown[]) => listTerminalProjectsMock(...args),
  listTerminalSessions: (...args: unknown[]) => listTerminalSessionsMock(...args),
  createTerminalProject: (...args: unknown[]) => createTerminalProjectMock(...args),
  updateTerminalProject: (...args: unknown[]) => updateTerminalProjectMock(...args),
  deleteTerminalProject: (...args: unknown[]) => deleteTerminalProjectMock(...args),
  createTerminalSession: (...args: unknown[]) => createTerminalSessionMock(...args),
  deleteTerminalSession: (...args: unknown[]) => deleteTerminalSessionMock(...args),
}));

vi.mock("./terminal-surface", () => ({
  TerminalSurface: (props: unknown) => {
    terminalSurfacePropsSpy(props);
    return <div data-testid="terminal-surface" />;
  },
}));

describe("TerminalWorkspace", () => {
  beforeEach(() => {
    listTerminalProjectsMock.mockReset();
    listTerminalSessionsMock.mockReset();
    createTerminalProjectMock.mockReset();
    updateTerminalProjectMock.mockReset();
    deleteTerminalProjectMock.mockReset();
    createTerminalSessionMock.mockReset();
    deleteTerminalSessionMock.mockReset();
    terminalSurfacePropsSpy.mockReset();

    listTerminalProjectsMock.mockResolvedValue([
      {
        projectId: "project-1",
        name: "browser-viewer",
        createdAt: "2026-03-30T00:00:00.000Z",
        isDefault: true,
      },
      {
        projectId: "project-2",
        name: "coze-hub",
        createdAt: "2026-03-30T01:00:00.000Z",
        isDefault: false,
      },
    ]);
    listTerminalSessionsMock.mockResolvedValue([]);
    createTerminalProjectMock.mockImplementation(async (_apiBase, _token, payload) => ({
      projectId: "project-3",
      name: payload.name,
      createdAt: "2026-03-30T02:00:00.000Z",
      isDefault: false,
    }));
    updateTerminalProjectMock.mockImplementation(async (_apiBase, _token, projectId, payload) => ({
      projectId,
      name: payload.name,
      createdAt: "2026-03-30T00:00:00.000Z",
      isDefault: true,
    }));
    deleteTerminalProjectMock.mockResolvedValue(undefined);
    createTerminalSessionMock.mockResolvedValue({
      terminalSessionId: "terminal-1",
      terminalUrl: "/terminal/terminal-1",
    });
    deleteTerminalSessionMock.mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not auto-create a terminal session on mount", async () => {
    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "browser-viewer" }),
      ).toBeInTheDocument();
    });

    expect(createTerminalSessionMock).not.toHaveBeenCalled();
  });

  it("renders the home action before the project tabs and uses a plain plus icon for new project", async () => {
    const onNavigateHome = vi.fn();
    const { container } = render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        onNavigateHome={onNavigateHome}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Go home" })).toBeInTheDocument();
    });

    const homeButton = screen.getByRole("button", { name: "Go home" });
    const projectButton = screen.getByRole("button", { name: "browser-viewer" });

    expect(
      homeButton.compareDocumentPosition(projectButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector(".lucide-folder-plus")).toBeNull();
    expect(
      screen.getByRole("button", { name: "New Project" }).querySelector(".lucide-plus"),
    ).not.toBeNull();

    fireEvent.click(homeButton);
    expect(onNavigateHome).toHaveBeenCalledTimes(1);
  });

  it("renders terminal shortcut hints in the header", async () => {
    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(/Project Alt\+\[ \/ Alt\+\].*Tab Alt\+Shift\+\[ \/ Alt\+Shift\+\]/),
      ).toBeInTheDocument();
    });
  });

  it("creates a terminal session from the new button without browser linkage", async () => {
    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(listTerminalSessionsMock).toHaveBeenCalled();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "New Terminal" })[0]!);

    await waitFor(() => {
      expect(createTerminalSessionMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        { projectId: "project-1", cwd: undefined },
      );
    });
  });

  it("creates a new terminal project and switches to it", async () => {
    createTerminalSessionMock.mockResolvedValueOnce({
      terminalSessionId: "terminal-3",
      terminalUrl: "/terminal/terminal-3",
    });
    listTerminalProjectsMock
      .mockResolvedValueOnce([
        {
          projectId: "project-1",
          name: "browser-viewer",
          createdAt: "2026-03-30T00:00:00.000Z",
          isDefault: true,
        },
        {
          projectId: "project-2",
          name: "coze-hub",
          createdAt: "2026-03-30T01:00:00.000Z",
          isDefault: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          projectId: "project-1",
          name: "browser-viewer",
          createdAt: "2026-03-30T00:00:00.000Z",
          isDefault: true,
        },
        {
          projectId: "project-2",
          name: "coze-hub",
          createdAt: "2026-03-30T01:00:00.000Z",
          isDefault: false,
        },
        {
          projectId: "project-3",
          name: "playground",
          createdAt: "2026-03-30T02:00:00.000Z",
          isDefault: false,
        },
      ]);
    listTerminalSessionsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          terminalSessionId: "terminal-3",
          projectId: "project-3",
          name: "playground",
          command: "bash",
          args: [],
          cwd: "/tmp",
          status: "running",
          createdAt: "2026-03-30T02:00:00.000Z",
        },
      ]);

    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "browser-viewer" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    fireEvent.change(screen.getByLabelText("Project Name"), {
      target: { value: "playground" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => {
      expect(createTerminalProjectMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        { name: "playground" },
      );
    });
    await waitFor(() => {
      expect(createTerminalSessionMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        { projectId: "project-3" },
      );
    });

    expect(screen.getByRole("button", { name: "New Project" })).toHaveClass(
      "bg-primary",
      "h-9",
      "px-4",
    );
    expect(
      screen
        .getAllByRole("button", { name: "playground" })
        .some((element) => element.getAttribute("aria-pressed") === "true"),
    ).toBe(true);
    expect(screen.getAllByRole("button", { name: "playground" })).toHaveLength(2);
    expect(terminalSurfacePropsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminalSessionId: "terminal-3",
      }),
    );
  });

  it("does not bounce back to the previous terminal route while creating a project", async () => {
    const onActiveSessionChange = vi.fn();
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
    ]);
    createTerminalSessionMock.mockResolvedValueOnce({
      terminalSessionId: "terminal-3",
      terminalUrl: "/terminal/terminal-3",
    });
    listTerminalProjectsMock
      .mockResolvedValueOnce([
        {
          projectId: "project-1",
          name: "browser-viewer",
          createdAt: "2026-03-30T00:00:00.000Z",
          isDefault: true,
        },
        {
          projectId: "project-2",
          name: "coze-hub",
          createdAt: "2026-03-30T01:00:00.000Z",
          isDefault: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          projectId: "project-1",
          name: "browser-viewer",
          createdAt: "2026-03-30T00:00:00.000Z",
          isDefault: true,
        },
        {
          projectId: "project-2",
          name: "coze-hub",
          createdAt: "2026-03-30T01:00:00.000Z",
          isDefault: false,
        },
        {
          projectId: "project-3",
          name: "playground",
          createdAt: "2026-03-30T02:00:00.000Z",
          isDefault: false,
        },
      ]);
    listTerminalSessionsMock
      .mockResolvedValueOnce([
        {
          terminalSessionId: "terminal-1",
          projectId: "project-1",
          name: "shell-1",
          command: "bash",
          args: [],
          cwd: "/tmp",
          status: "running",
          createdAt: "2026-03-30T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          terminalSessionId: "terminal-1",
          projectId: "project-1",
          name: "shell-1",
          command: "bash",
          args: [],
          cwd: "/tmp",
          status: "running",
          createdAt: "2026-03-30T00:00:00.000Z",
        },
        {
          terminalSessionId: "terminal-3",
          projectId: "project-3",
          name: "playground",
          command: "bash",
          args: [],
          cwd: "/tmp",
          status: "running",
          createdAt: "2026-03-30T02:00:00.000Z",
        },
      ]);

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        initialTerminalSessionId="terminal-1"
        onActiveSessionChange={onActiveSessionChange}
      />,
    );

    await waitFor(() => {
      expect(onActiveSessionChange).toHaveBeenCalledWith("terminal-1");
    });

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    fireEvent.change(screen.getByLabelText("Project Name"), {
      target: { value: "playground" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => {
      expect(onActiveSessionChange).toHaveBeenLastCalledWith("terminal-3");
    });

    expect(onActiveSessionChange.mock.calls.map((call) => call[0])).toEqual([
      "terminal-1",
      "terminal-3",
    ]);
  });

  it("renames the active terminal project", async () => {
    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "browser-viewer" })).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "browser-viewer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Project Name"), {
      target: { value: "browser-viewer-next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Project" }));

    await waitFor(() => {
      expect(updateTerminalProjectMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        "project-1",
        { name: "browser-viewer-next" },
      );
    });

    expect(screen.getByRole("button", { name: "browser-viewer-next" })).toBeInTheDocument();
  });

  it("deletes the active project and reloads the workspace", async () => {
    listTerminalSessionsMock
      .mockResolvedValueOnce([
        {
          terminalSessionId: "terminal-1",
          projectId: "project-1",
          name: "shell-1",
          command: "bash",
          args: [],
          cwd: "/tmp",
          status: "running",
          createdAt: "2026-03-30T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);
    listTerminalProjectsMock
      .mockResolvedValueOnce([
        {
          projectId: "project-1",
          name: "browser-viewer",
          createdAt: "2026-03-30T00:00:00.000Z",
          isDefault: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          projectId: "project-2",
          name: "coze-hub",
          createdAt: "2026-03-30T01:00:00.000Z",
          isDefault: true,
        },
      ]);

    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "browser-viewer" })).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "browser-viewer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(
      screen.getByText('Delete "browser-viewer" and all terminal tabs inside it. This cannot be undone.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteTerminalProjectMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        "project-1",
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "coze-hub" })).toBeInTheDocument();
    });
  });

  it("creates a new terminal session with the active session cwd", async () => {
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp/project-a",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        projectId: "project-2",
        name: "shell-2",
        command: "bash",
        args: [],
        cwd: "/tmp/project-b",
        status: "running",
        createdAt: "2026-03-30T01:00:00.000Z",
      },
    ]);

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        initialTerminalSessionId="terminal-2"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("shell-2")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "shell-2" }));
    fireEvent.click(screen.getAllByRole("button", { name: "New Terminal" })[0]!);

    await waitFor(() => {
      expect(createTerminalSessionMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        { projectId: "project-2", cwd: "/tmp/project-b" },
      );
    });
  });

  it("uses the latest cwd metadata from the active terminal session", async () => {
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp/project-a",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
    ]);

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        initialTerminalSessionId="terminal-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("terminal-surface")).toBeInTheDocument();
    });

    const props = terminalSurfacePropsSpy.mock.calls.at(-1)?.[0] as {
      onMetadata?: (metadata: { name: string; cwd: string }) => void;
    };
    act(() => {
      props.onMetadata?.({
        name: "project-b",
        cwd: "/tmp/project-b",
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "project-b" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "New Terminal" })[0]!);

    await waitFor(() => {
      expect(createTerminalSessionMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        { projectId: "project-1", cwd: "/tmp/project-b" },
      );
    });
  });

  it("reports the current active session after loading sessions", async () => {
    const onActiveSessionChange = vi.fn();
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        projectId: "project-1",
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
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        projectId: "project-1",
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
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        projectId: "project-1",
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
        projectId: "project-1",
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

  it("renders project switches above session tabs and filters sessions by active project", async () => {
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "viewer-shell",
        command: "bash",
        args: [],
        cwd: "/tmp/viewer",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        projectId: "project-2",
        name: "coze-shell",
        command: "bash",
        args: [],
        cwd: "/tmp/coze",
        status: "running",
        createdAt: "2026-03-30T01:00:00.000Z",
      },
    ]);

    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "viewer-shell" })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "viewer-shell" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "coze-shell" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "coze-hub" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "coze-shell" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "viewer-shell" })).toBeNull();
  });

  it("switches terminal tabs with global shortcuts", async () => {
    const onActiveSessionChange = vi.fn();
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        projectId: "project-1",
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
      expect(screen.getByRole("button", { name: "shell-2" })).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: "]", altKey: true, shiftKey: true });

    await waitFor(() => {
      expect(onActiveSessionChange).toHaveBeenLastCalledWith("terminal-2");
    });

    fireEvent.keyDown(window, { key: "[", altKey: true, shiftKey: true });

    await waitFor(() => {
      expect(onActiveSessionChange).toHaveBeenLastCalledWith("terminal-1");
    });
  });

  it("prevents terminal shortcut default behavior when no other terminal tab exists", async () => {
    const onActiveSessionChange = vi.fn();
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
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
      expect(screen.getByRole("button", { name: "shell-1" })).toBeInTheDocument();
    });

    const event = new KeyboardEvent("keydown", {
      key: "]",
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    const prevented = !window.dispatchEvent(event);

    expect(prevented).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(onActiveSessionChange).toHaveBeenCalledTimes(1);
    expect(onActiveSessionChange).toHaveBeenLastCalledWith("terminal-1");
  });

  it("switches projects with global shortcuts while terminal surface is focused", async () => {
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "viewer-shell",
        command: "bash",
        args: [],
        cwd: "/tmp/viewer",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        projectId: "project-2",
        name: "coze-shell",
        command: "bash",
        args: [],
        cwd: "/tmp/coze",
        status: "running",
        createdAt: "2026-03-30T01:00:00.000Z",
      },
    ]);

    render(<TerminalWorkspace apiBase="http://localhost:5000" token="token-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-surface")).toBeInTheDocument();
    });

    const surface = screen.getByTestId("terminal-surface");
    surface.focus();

    fireEvent.keyDown(window, { key: "]", altKey: true });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "coze-hub" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(screen.getByRole("button", { name: "coze-shell" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "[", altKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "browser-viewer" }),
      ).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("keeps an empty active project open without reporting that the workspace is empty", async () => {
    const onNoSessionAvailable = vi.fn();
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        projectId: "project-1",
        name: "viewer-shell",
        command: "bash",
        args: [],
        cwd: "/tmp/viewer",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
    ]);

    render(
      <TerminalWorkspace
        apiBase="http://localhost:5000"
        token="token-1"
        onNoSessionAvailable={onNoSessionAvailable}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "viewer-shell" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "coze-hub" }));

    await waitFor(() => {
      expect(screen.getByText("No terminal tab yet. Create one to start.")).toBeInTheDocument();
    });
    expect(onNoSessionAvailable).not.toHaveBeenCalled();
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
        projectId: "project-1",
        name: "shell-1",
        command: "bash",
        args: [],
        cwd: "/tmp",
        status: "running",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
      {
        terminalSessionId: "terminal-2",
        projectId: "project-1",
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
      expect(screen.getByRole("button", { name: "shell-2" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "shell-2" })[0]!);

    expect(listTerminalSessionsMock).toHaveBeenCalledTimes(1);
  });
});
