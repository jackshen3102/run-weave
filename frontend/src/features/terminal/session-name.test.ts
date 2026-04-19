import { describe, expect, it } from "vitest";
import { formatTerminalSessionName } from "./session-name";

describe("formatTerminalSessionName", () => {
  it("uses the cwd basename when no foreground command is active", () => {
    expect(
      formatTerminalSessionName({
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: null,
      }),
    ).toBe("feat");
  });

  it("appends the active foreground command", () => {
    expect(
      formatTerminalSessionName({
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: "codex",
      }),
    ).toBe("feat(codex)");
  });

  it("hides interactive shell commands", () => {
    expect(
      formatTerminalSessionName({
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: "zsh",
      }),
    ).toBe("feat");
    expect(
      formatTerminalSessionName({
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer",
        activeCommand: "bash",
      }),
    ).toBe("browser-viewer");
  });
});
