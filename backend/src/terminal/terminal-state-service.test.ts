import { describe, expect, it } from "vitest";
import { TerminalStateService } from "./terminal-state-service";
import { TerminalStateStore } from "./terminal-state-store";

function createService(): TerminalStateService {
  return new TerminalStateService(new TerminalStateStore());
}

describe("TerminalStateService", () => {
  it("maps codex active command to agent idle", () => {
    const service = createService();

    expect(
      service.setShellActiveCommand("terminal-1", {
        status: "running",
        command: "zsh",
        activeCommand: "codex",
      }),
    ).toEqual({ state: "agent_idle", agent: "codex" });
  });

  it("maps non-codex or cleared active command to shell idle", () => {
    const service = createService();

    expect(
      service.setShellActiveCommand("terminal-1", {
        status: "running",
        command: "zsh",
        activeCommand: "node",
      }),
    ).toEqual({ state: "shell_idle", agent: null });
    expect(
      service.setShellActiveCommand("terminal-1", {
        status: "running",
        command: "zsh",
        activeCommand: null,
      }),
    ).toEqual({ state: "shell_idle", agent: null });
  });

  it("returns shell idle for exited sessions even when codex is still recorded", () => {
    const service = createService();
    service.handleAgentHook("terminal-1", "codex", "UserPromptSubmit");

    expect(
      service.getCurrent("terminal-1", {
        status: "exited",
        command: "zsh",
        activeCommand: "codex",
      }),
    ).toEqual({ state: "shell_idle", agent: null });
  });

  it("derives current state from active command when no hook was recorded", () => {
    const service = createService();

    expect(
      service.getCurrent("terminal-1", {
        status: "running",
        command: "zsh",
        activeCommand: "codex",
      }),
    ).toEqual({ state: "agent_idle", agent: "codex" });
    expect(
      service.getCurrent("terminal-2", {
        status: "running",
        command: "zsh",
        activeCommand: "sleep",
      }),
    ).toEqual({ state: "shell_idle", agent: null });
  });

  it("maps codex hooks to agent running and idle", () => {
    const service = createService();

    expect(
      service.handleAgentHook("terminal-1", "codex", "SessionStart"),
    ).toEqual({ state: "agent_idle", agent: "codex" });
    expect(
      service.handleAgentHook("terminal-1", "codex", "UserPromptSubmit"),
    ).toEqual({ state: "agent_running", agent: "codex" });
    expect(service.handleAgentHook("terminal-1", "codex", "Stop")).toEqual({
      state: "agent_idle",
      agent: "codex",
    });
  });

  it("does not let stale hook state override cleared active command metadata", () => {
    const service = createService();
    service.handleAgentHook("terminal-1", "codex", "SessionStart");

    expect(
      service.getCurrent("terminal-1", {
        status: "running",
        command: "zsh",
        activeCommand: null,
      }),
    ).toEqual({ state: "shell_idle", agent: null });

    service.setShellActiveCommand("terminal-1", {
      status: "running",
      command: "zsh",
      activeCommand: null,
    });
    expect(
      service.getCurrent("terminal-1", {
        status: "running",
        command: "zsh",
        activeCommand: null,
      }),
    ).toEqual({ state: "shell_idle", agent: null });
  });

  it("keeps codex session state when tmux reports the node launcher as active", () => {
    const service = createService();

    expect(
      service.setShellActiveCommand("terminal-1", {
        status: "running",
        command: "codex",
        activeCommand: "node",
      }),
    ).toEqual({ state: "agent_idle", agent: "codex" });

    service.handleAgentHook("terminal-1", "codex", "UserPromptSubmit");
    expect(
      service.setShellActiveCommand("terminal-1", {
        status: "running",
        command: "codex",
        activeCommand: "node",
      }),
    ).toEqual({ state: "agent_running", agent: "codex" });
  });
});
