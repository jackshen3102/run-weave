import { describe, expect, it } from "vitest";
import { formatTerminalSessionName } from "./session-name";

describe("formatTerminalSessionName", () => {
  it("normalizes legacy underscore command names", () => {
    expect(formatTerminalSessionName("feat_node")).toBe("feat(node)");
    expect(formatTerminalSessionName("feat_codex")).toBe("feat(codex)");
    expect(formatTerminalSessionName("feat_coco")).toBe("feat(coco)");
  });

  it("normalizes legacy node wrapper command names", () => {
    expect(formatTerminalSessionName("feat_codex(node)")).toBe("feat(codex)");
    expect(formatTerminalSessionName("feat_coco(node)")).toBe("feat(coco)");
  });

  it("uses the cwd label when persisted names came from the shell command", () => {
    expect(
      formatTerminalSessionName("/bin/zsh", {
        command: "/bin/zsh",
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
      }),
    ).toBe("feat");
    expect(
      formatTerminalSessionName("zsh", {
        command: "/bin/zsh",
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer",
      }),
    ).toBe("browser-viewer");
  });

  it("hides legacy interactive shell suffixes like tmux metadata naming", () => {
    expect(formatTerminalSessionName("browser-viewer_zsh")).toBe("browser-viewer");
    expect(formatTerminalSessionName("feat_bash")).toBe("feat");
  });

  it("keeps ordinary names with underscores", () => {
    expect(formatTerminalSessionName("coze_space")).toBe("coze_space");
    expect(formatTerminalSessionName("my_project")).toBe("my_project");
  });
});
