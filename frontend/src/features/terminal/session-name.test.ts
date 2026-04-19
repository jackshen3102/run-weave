import { describe, expect, it } from "vitest";
import { formatTerminalSessionName } from "./session-name";

const fixtureBrowserViewerPath = "/workspace/browser-viewer";
const fixtureFeaturePath = "/workspace/feat";

describe("formatTerminalSessionName", () => {
  it("uses the cwd basename when no foreground command is active", () => {
    expect(
      formatTerminalSessionName({
        cwd: fixtureFeaturePath,
        activeCommand: null,
      }),
    ).toBe("feat");
  });

  it("appends the active foreground command", () => {
    expect(
      formatTerminalSessionName({
        cwd: fixtureFeaturePath,
        activeCommand: "codex",
      }),
    ).toBe("feat(codex)");
  });

  it("hides interactive shell commands", () => {
    expect(
      formatTerminalSessionName({
        cwd: fixtureFeaturePath,
        activeCommand: "zsh",
      }),
    ).toBe("feat");
    expect(
      formatTerminalSessionName({
        cwd: fixtureBrowserViewerPath,
        activeCommand: "bash",
      }),
    ).toBe("browser-viewer");
  });
});
