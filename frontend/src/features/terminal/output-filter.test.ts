import { describe, expect, it } from "vitest";
import { filterBrowserHandledTerminalOutput } from "./output-filter";

describe("terminal output filter", () => {
  it("removes mouse tracking mode toggles from terminal output", () => {
    expect(
      filterBrowserHandledTerminalOutput(
        "\u001b[?1000h\u001b[?1002;1006hCodex\u001b[?1006l",
      ),
    ).toBe("Codex");
  });

  it("keeps non-mouse terminal modes intact", () => {
    expect(filterBrowserHandledTerminalOutput("\u001b[?1049hTUI\u001b[?1049l")).toBe(
      "\u001b[?1049hTUI\u001b[?1049l",
    );
  });

  it("removes xterm mode queries that crash xterm requestMode handling", () => {
    expect(filterBrowserHandledTerminalOutput("a\u001b[?1000$p\u001b[?25$pb")).toBe(
      "ab",
    );
  });
});
