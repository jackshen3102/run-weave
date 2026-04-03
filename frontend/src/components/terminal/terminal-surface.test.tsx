import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSurface } from "./terminal-surface";

const terminalOpenMock = vi.fn();
const terminalDisposeMock = vi.fn();
const terminalLoadAddonMock = vi.fn();
const terminalFocusMock = vi.fn();
const fitAddonFitMock = vi.fn();
const useTerminalConnectionMock = vi.fn();
const sendInputMock = vi.fn();
const sendResizeMock = vi.fn();

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {}
    unicode = { activeVersion: "" };
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    open = terminalOpenMock;
    dispose = terminalDisposeMock;
    loadAddon = terminalLoadAddonMock;
    focus = terminalFocusMock;
    write = vi.fn();
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = fitAddonFitMock;
    proposeDimensions = vi.fn(() => ({ cols: 120, rows: 36 }));
  },
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    constructor() {}
  },
}));

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    constructor() {}
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("../../features/terminal/use-terminal-connection", () => ({
  useTerminalConnection: (...args: unknown[]) => useTerminalConnectionMock(...args),
}));

describe("TerminalSurface", () => {
  let rafSpy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    terminalOpenMock.mockReset();
    terminalDisposeMock.mockReset();
    terminalLoadAddonMock.mockReset();
    terminalFocusMock.mockReset();
    fitAddonFitMock.mockReset();
    useTerminalConnectionMock.mockReset();
    sendInputMock.mockReset();
    sendResizeMock.mockReset();

    useTerminalConnectionMock.mockReturnValue({
      connectionStatus: "connected",
      terminalStatus: "running",
      exitCode: null,
      error: null,
      sendInput: sendInputMock,
      sendResize: sendResizeMock,
    });
  });

  afterEach(() => {
    cleanup();
    rafSpy?.mockRestore();
  });

  it("re-fits after mount so the terminal uses the final container width", async () => {
    render(
      <TerminalSurface
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    await waitFor(() => {
      expect(sendResizeMock).toHaveBeenCalledTimes(2);
    });
    expect(fitAddonFitMock).toHaveBeenCalledTimes(2);
  });

  it("uses tighter vertical padding so the last row stays visible", () => {
    render(
      <TerminalSurface
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    expect(screen.getByLabelText("Terminal emulator")).toHaveClass(
      "px-3",
      "pt-2",
      "pb-2",
    );
  });

  it("does not render the terminal status bar", () => {
    render(
      <TerminalSurface
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    expect(screen.queryByText("live")).not.toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });
});
