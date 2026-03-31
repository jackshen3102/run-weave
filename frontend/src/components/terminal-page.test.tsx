import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
let terminalOnDataHandler: ((data: string) => void) | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {}
    onData = vi.fn((handler: (data: string) => void) => {
      terminalOnDataHandler = handler;
      return {
        dispose: vi.fn(),
      };
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

const webglAddonInstance = { dispose: vi.fn() };
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
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    getTerminalSessionMock.mockReset();
    useTerminalConnectionMock.mockReset();
    terminalOpenMock.mockReset();
    terminalWriteMock.mockReset();
    terminalFocusMock.mockReset();
    terminalDisposeMock.mockReset();
    terminalLoadAddonMock.mockReset();
    fitAddonFitMock.mockReset();
    webglAddonConstructor.mockClear();
    webglAddonInstance.dispose.mockClear();
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
    useTerminalConnectionMock.mockReturnValue({
      connectionStatus: "connected",
      terminalStatus: "running",
      exitCode: null,
      error: null,
      output: "$ pwd\n/tmp/demo\n",
      clearOutput: vi.fn(),
      sendInput: vi.fn(),
      sendResize: vi.fn(),
      sendSignal: vi.fn(),
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
    expect(screen.getByLabelText("Terminal output")).toHaveTextContent("/tmp/demo");
    expect(terminalOpenMock).toHaveBeenCalledTimes(1);
    expect(terminalWriteMock).toHaveBeenCalledWith("$ pwd\n/tmp/demo\n");
    expect(fitAddonFitMock).toHaveBeenCalled();
    expect(terminalLoadAddonMock).toHaveBeenCalledTimes(2);
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
    const sendInput = vi.fn();
    const sendResize = vi.fn();
    useTerminalConnectionMock.mockReturnValue({
      connectionStatus: "connected",
      terminalStatus: "running",
      exitCode: null,
      error: null,
      output: "$ ",
      clearOutput: vi.fn(),
      sendInput,
      sendResize,
      sendSignal: vi.fn(),
    });

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
      expect(sendResize).toHaveBeenCalledWith(120, 36);
    });

    expect(sendInput).toHaveBeenCalledWith("\r");
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it("renders exit state from terminal runtime status", async () => {
    useTerminalConnectionMock.mockReturnValue({
      connectionStatus: "closed",
      terminalStatus: "exited",
      exitCode: 130,
      error: null,
      output: "bash-3.2$ exit\n",
      clearOutput: vi.fn(),
      sendInput: vi.fn(),
      sendResize: vi.fn(),
      sendSignal: vi.fn(),
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

  it("loads the webgl addon", async () => {
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
  });

});
