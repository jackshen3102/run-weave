import { describe, expect, it, vi } from "vitest";
import type { TerminalSessionListItem } from "@browser-viewer/shared";
import { resolveReusableTerminalSession } from "./terminal-session-reuse";

function buildSession(
  patch: Partial<TerminalSessionListItem> & {
    terminalSessionId: string;
    createdAt: string;
  },
): TerminalSessionListItem {
  return {
    terminalSessionId: patch.terminalSessionId,
    projectId: patch.projectId ?? "project-default",
    command: patch.command ?? "bash",
    args: patch.args ?? ["-l"],
    cwd: patch.cwd ?? "/tmp/demo",
    activeCommand: patch.activeCommand ?? null,
    status: patch.status ?? "running",
    createdAt: patch.createdAt,
    exitCode: patch.exitCode,
  };
}

describe("resolveReusableTerminalSession", () => {
  it("keeps reusing the newest running terminal even when it is an old pty session", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
    });

    const reusable = resolveReusableTerminalSession(
      [
        buildSession({
          terminalSessionId: "terminal-pty",
          createdAt: "2026-03-29T02:00:00.000Z",
        }),
        buildSession({
          terminalSessionId: "terminal-tmux-old",
          createdAt: "2026-03-29T00:00:00.000Z",
        }),
        buildSession({
          terminalSessionId: "terminal-tmux-new",
          createdAt: "2026-03-29T01:00:00.000Z",
        }),
      ],
      "http://127.0.0.1:5001",
    );

    expect(reusable?.terminalSessionId).toBe("terminal-pty");
  });
});
