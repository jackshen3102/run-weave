import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSurface } from "./terminal-surface";

const { webLinksAddonInstance, webLinksAddonConstructor } = vi.hoisted(() => {
  const instance = {};
  return {
    webLinksAddonInstance: instance,
    webLinksAddonConstructor: vi.fn(() => instance),
  };
});

const terminalOpenMock = vi.fn();
const terminalDisposeMock = vi.fn();
const terminalLoadAddonMock = vi.fn();
const terminalFocusMock = vi.fn();
const terminalConstructorOptions: Array<Record<string, unknown>> = [];
const fitAddonFitMock = vi.fn();
const useTerminalConnectionMock = vi.fn();
const createTerminalSessionClipboardImageMock = vi.fn();
const sendInputMock = vi.fn();
const sendResizeMock = vi.fn();

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      terminalConstructorOptions.push(options);
    }
    unicode = { activeVersion: "" };
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    open = (container: HTMLElement) => {
      const helperTextarea = document.createElement("textarea");
      helperTextarea.className = "xterm-helper-textarea";
      helperTextarea.addEventListener("paste", (event) => {
        event.stopPropagation();
      });
      container.appendChild(helperTextarea);
      terminalOpenMock(container);
    };
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

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: webLinksAddonConstructor,
}));

vi.mock("../../features/terminal/use-terminal-connection", () => ({
  useTerminalConnection: (...args: unknown[]) => useTerminalConnectionMock(...args),
}));

vi.mock("../../services/terminal", () => ({
  createTerminalSessionClipboardImage: (...args: unknown[]) =>
    createTerminalSessionClipboardImageMock(...args),
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
    terminalConstructorOptions.length = 0;
    fitAddonFitMock.mockReset();
    useTerminalConnectionMock.mockReset();
    createTerminalSessionClipboardImageMock.mockReset();
    sendInputMock.mockReset();
    sendResizeMock.mockReset();
    webLinksAddonConstructor.mockClear();

    useTerminalConnectionMock.mockReturnValue({
      connectionStatus: "connected",
      terminalStatus: "running",
      exitCode: null,
      error: null,
      sendInput: sendInputMock,
      sendResize: sendResizeMock,
    });
    createTerminalSessionClipboardImageMock.mockResolvedValue({
      fileName: "browser-viewer-terminal-image-20260404-120000-abcdef.png",
      filePath:
        "/tmp/browser-viewer-terminal-images/browser-viewer-terminal-image-20260404-120000-abcdef.png",
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

  it("configures deeper xterm scrollback for long terminal transcripts", () => {
    render(
      <TerminalSurface
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    expect(terminalConstructorOptions.at(-1)?.scrollback).toBe(50_000);
  });

  it("loads the web links addon so terminal URLs are clickable", async () => {
    render(
      <TerminalSurface
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    await waitFor(() => {
      expect(terminalOpenMock).toHaveBeenCalledTimes(1);
    });

    expect(webLinksAddonConstructor).toHaveBeenCalledTimes(1);
    expect(terminalLoadAddonMock).toHaveBeenCalledWith(webLinksAddonInstance);
  });

  it("uploads pasted clipboard images, displays image references, and inserts the stored path", async () => {
    render(
      <TerminalSurface
        apiBase="http://localhost:5000"
        terminalSessionId="terminal-1"
        token="token-1"
      />,
    );

    const file = new File([new Uint8Array([1, 2, 3, 4])], "clip.png", {
      type: "image/png",
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });

    const helperTextarea = document.querySelector(".xterm-helper-textarea");
    expect(helperTextarea).toBeTruthy();
    helperTextarea?.dispatchEvent(event);

    await waitFor(() => {
      expect(createTerminalSessionClipboardImageMock).toHaveBeenCalledWith(
        "http://localhost:5000",
        "token-1",
        "terminal-1",
        {
          mimeType: "image/png",
          dataBase64: "AQIDBA==",
        },
      );
    });
    expect(createTerminalSessionClipboardImageMock).toHaveBeenCalledTimes(1);
    expect(sendInputMock).toHaveBeenCalledWith(
      "'/tmp/browser-viewer-terminal-images/browser-viewer-terminal-image-20260404-120000-abcdef.png'",
    );
    expect(sendInputMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("[Image #1]")).toBeInTheDocument();
  });
});
