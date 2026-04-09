import { describe, expect, it, vi } from "vitest";
import { createTerminalRuntimeRecorder } from "./runtime-recorder";

describe("createTerminalRuntimeRecorder", () => {
  it("tracks the active foreground command in the session name", async () => {
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        name: "browser-viewer",
        cwd: "/Users/bytedance/Desktop/vscode/browser-viewer",
      })),
      updateSessionMetadata: vi.fn(async () => undefined),
      appendOutput: vi.fn(),
      markExited: vi.fn(),
    };
    const recorder = createTerminalRuntimeRecorder(
      terminalSessionManager as never,
      "terminal-1",
    );

    recorder.onData(
      "\u001b]633;BrowserViewerCommand=codex\u0007",
    );
    await Promise.resolve();

    expect(terminalSessionManager.updateSessionMetadata).toHaveBeenCalledWith(
      "terminal-1",
      {
        name: "browser-viewer(codex)",
        cwd: "/Users/bytedance/Desktop/vscode/browser-viewer",
      },
    );

    terminalSessionManager.updateSessionMetadata.mockClear();

    recorder.onData(
      "\u001b]633;BrowserViewerCommand=\u0007",
    );
    await Promise.resolve();

    expect(terminalSessionManager.updateSessionMetadata).toHaveBeenCalledWith(
      "terminal-1",
      {
        name: "browser-viewer",
        cwd: "/Users/bytedance/Desktop/vscode/browser-viewer",
      },
    );
    expect(terminalSessionManager.appendOutput).not.toHaveBeenCalled();
  });
});
