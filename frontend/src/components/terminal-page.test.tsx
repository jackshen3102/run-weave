import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../services/http";
import { TerminalPage } from "./terminal-page";

const getTerminalSessionMock = vi.fn();
const useTerminalConnectionMock = vi.fn();
const terminalOpenMock = vi.fn();
const terminalWriteMock = vi.fn();
const terminalFocusMock = vi.fn();
const terminalDisposeMock = vi.fn();
const terminalLoadAddonMock = vi.fn();
const fitAddonFitMock = vi.fn();
// Stable send mocks — must not change identity between renders or effects re-run.
const sendInputMock = vi.fn();
const sendResizeMock = vi.fn();
const sendSignalMock = vi.fn();
let terminalOnDataHandler: ((data: string) => void) | null = null;
let capturedOnOutput: ((data: string) => void) | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {}
    unicode = { activeVersion: "" };
    onData = vi.fn((handler: (data: string) => void) => {
      terminalOnDataHandler = handler;
      return { dispose: vi.fn() };
    });
    open = terminalOpenMock;
    write = terminalWriteMock;
    focus = terminalFocusMock;
    dispose = terminalDisposeMock;
    loadAddon = terminalLoadAddonMock;
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

const webglAddonInstance = { dispose: vi.fn(), onContextLoss: vi.fn() };
const webglAddonConstructor = vi.fn(() => webglAddonInstance);

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      return webglAddonConstructor();
    }
  },
}));

vi.mock("../services/terminal", () => ({
  getTerminalSession: (...args: unknown[]) => getTerminalSessionMock(...args),
}));

vi.mock("../features/terminal/use-terminal-connection", () => ({
  useTerminalConnection: (...args: unknown[]) => useTerminalConnectionMock(...args),
}));

describe("TerminalPage", () => {
  let rafSpy: { mockRestore: () => void } | undefined;

  afterEach(() => {
    cleanup();
    rafSpy?.mockRestore();
  });

  beforeEach(() => {
    // Make requestAnimationFrame flush synchronously so RAF-batched writes are
    // immediately testable without async flushing.
    rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    capturedOnOutput = null;
    getTerminalSessionMock.mockReset();
    useTerminalConnectionMock.mockReset();
    terminalOpenMock.mockReset();
    terminalWriteMock.mockReset();
    terminalFocusMock.mockReset();
    terminalDisposeMock.mockReset();
    terminalLoadAddonMock.mockReset();
    fitAddonFitMock.mockReset();
    sendInputMock.mockReset();
    sendResizeMock.mockReset();
    sendSignalMock.mockReset();
    webglAddonConstructor.mockClear();
    webglAddonInstance.dispose.mockClear();
    webglAddonInstance.onContextLoss.mockClear();
    terminalOnDataHandler = null;

    getTerminalSessionMock.mockResolvedValue({
      terminalSessionId: "terminal-1",
      name: "Demo shell",
      command: "bash",
      args: ["-l"],
      cwd: "/tmp/demo",
      scrollback: "$ pwd\n/tmp/demo\n",
      status: "running",
      createdAt: "2026-03-29T00:00:00.000Z",
    });

    // Use stable function references so useEffect([sendInput, sendResize, ...])
    // does not re-run on every render due to new function identity.
    useTerminalConnectionMock.mockImplementation((params: { onOutput?: (data: string) => void }) => {
      capturedOnOutput = params.onOutput ?? null;
      return {
        connectionStatus: "connected",
        terminalStatus: "running",
        exitCode: null,
        error: null,
        sendInput: sendInputMock,
        sendResize: sendResizeMock,
        sendSignal: sendSignalMock,
      };
    });
  });

  it("renders the terminal page for a terminal session", async () => {
    render(
      <TerminalPage
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    await waitFor(() => {
      expect(getTerminalSessionMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        "terminal-1",
      );
    });

    expect(await screen.findByText("Demo shell")).toBeInTheDocument();
    expect(screen.getByText("bash -l")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByLabelText("Terminal emulator")).toBeInTheDocument();
    expect(terminalOpenMock).toHaveBeenCalledTimes(1);
    expect(fitAddonFitMock).toHaveBeenCalled();

    act(() => {
      capturedOnOutput?.("$ pwd\n/tmp/demo\n");
    });
    expect(terminalWriteMock).toHaveBeenCalledWith("$ pwd\n/tmp/demo\n");
  });

  it("clears auth state when terminal APIs return 401", async () => {
    const onAuthExpired = vi.fn();
    getTerminalSessionMock.mockRejectedValue(
      new HttpError(401, "GET /api/terminal/session/terminal-1 failed: 401"),
    );

    render(
      <TerminalPage
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
        onAuthExpired={onAuthExpired}
      />,
    );

    await waitFor(() => {
      expect(onAuthExpired).toHaveBeenCalledTimes(1);
    });
  });

  it("sends terminal input and resize events through the connection", async () => {

    render(
      <TerminalPage
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    const emulator = await screen.findByLabelText("Terminal emulator");
    expect(emulator).toBeInTheDocument();
    terminalOnDataHandler?.(
      "\u001b]10;rgb:e2e2/e8e8/f0f0\u001b\\\u001b]11;rgb:0b0b/1212/2020\u001b\\\u001b[?276;2$y",
    );
    terminalOnDataHandler?.("\r");

    await waitFor(() => {
      expect(sendResizeMock).toHaveBeenCalledWith(120, 36);
    });

    expect(sendInputMock).toHaveBeenCalledWith("\r");
    expect(sendInputMock).toHaveBeenCalledTimes(1);
  });

  it("renders exit state from terminal runtime status", async () => {
    useTerminalConnectionMock.mockImplementation((params: { onOutput?: (data: string) => void }) => {
      capturedOnOutput = params.onOutput ?? null;
      return {
        connectionStatus: "closed",
        terminalStatus: "exited",
        exitCode: 130,
        error: null,
        sendInput: sendInputMock,
        sendResize: sendResizeMock,
        sendSignal: sendSignalMock,
      };
    });

    render(
      <TerminalPage
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    expect(await screen.findByText("Exited (130)")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("loads the webgl addon with unicode11", async () => {
    render(
      <TerminalPage
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    await waitFor(() => {
      expect(terminalOpenMock).toHaveBeenCalledTimes(1);
    });

    expect(webglAddonConstructor).toHaveBeenCalledTimes(1);
    expect(terminalLoadAddonMock).toHaveBeenCalledWith(webglAddonInstance);
    // FitAddon + Unicode11Addon + WebglAddon = 3 loadAddon calls
    expect(terminalLoadAddonMock).toHaveBeenCalledTimes(3);
  });
});
