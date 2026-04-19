import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTerminalRuntimeRecorder } from "./runtime-recorder";

const fixtureBrowserViewerPath = path.resolve(process.cwd(), "..");

describe("createTerminalRuntimeRecorder", () => {
  it("tracks the active foreground command in session metadata", async () => {
    const terminalSessionManager = {
      getSession: vi.fn(() => ({
        id: "terminal-1",
        cwd: fixtureBrowserViewerPath,
        activeCommand: null,
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
        cwd: fixtureBrowserViewerPath,
        activeCommand: "codex",
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
        cwd: fixtureBrowserViewerPath,
        activeCommand: null,
      },
    );
    expect(terminalSessionManager.appendOutput).not.toHaveBeenCalled();
  });
});
