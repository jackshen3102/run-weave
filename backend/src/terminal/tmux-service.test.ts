import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxRebuildLimitError, TmuxService } from "./tmux-service";

function createService(
  execFileImpl: TmuxService["execFileImpl"],
  env: NodeJS.ProcessEnv = {},
): TmuxService {
  return new TmuxService({
    env,
    execFile: execFileImpl,
    socketPath: "/tmp/runweave-test/tmux.sock",
    now: () => 1_000,
  });
}

describe("TmuxService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates stable runweave session names", () => {
    const service = createService(vi.fn());

    expect(service.buildSessionName("terminal-abc_123")).toBe(
      "runweave-terminal-abc_123",
    );
    expect(service.buildSessionName("terminal/../bad id")).toBe(
      "runweave-terminal-bad-id",
    );
  });

  it("serializes actions for the same terminal session", async () => {
    const service = createService(vi.fn());
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;

    const first = service.withSessionLock("terminal-1", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    const second = service.withSessionLock("terminal-1", async () => {
      order.push("second");
    });

    await vi.waitFor(() => {
      expect(order).toEqual(["first:start"]);
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("builds tmux attach commands against the dedicated socket and config", () => {
    const service = createService(vi.fn(), { TMUX_BINARY: "/usr/bin/tmux" });
    const target = {
      sessionName: "runweave-terminal-1",
      socketPath: "/tmp/runweave-test/tmux.sock",
    };

    expect(service.buildAttachCommand(target, "/tmp/demo")).toEqual({
      command: "/usr/bin/tmux",
      args: [
        "-S",
        "/tmp/runweave-test/tmux.sock",
        "-f",
        "/tmp/runweave-test/tmux.conf",
        "new-session",
        "-A",
        "-s",
        "runweave-terminal-1",
        "-c",
        "/tmp/demo",
      ],
    });
  });

  it("includes the original launch command when creating a missing tmux session", () => {
    const service = createService(vi.fn(), { TMUX_BINARY: "/usr/bin/tmux" });
    const target = {
      sessionName: "runweave-terminal-1",
      socketPath: "/tmp/runweave-test/tmux.sock",
    };

    expect(
      service.buildAttachCommand(target, "/tmp/demo", {
        command: "bash",
        args: ["-lc", "printf 'tmux-ok\\n'; sleep 60"],
      }),
    ).toEqual({
      command: "/usr/bin/tmux",
      args: [
        "-S",
        "/tmp/runweave-test/tmux.sock",
        "-f",
        "/tmp/runweave-test/tmux.conf",
        "new-session",
        "-A",
        "-s",
        "runweave-terminal-1",
        "-c",
        "/tmp/demo",
        "bash -lc 'printf '\\''tmux-ok\\n'\\''; sleep 60'",
      ],
    });
  });

  it("creates missing tmux sessions detached before attaching clients", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const service = createService(execFileImpl);

    await service.createDetachedSession(
      {
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave-test/tmux.sock",
      },
      "/tmp/demo",
      {
        command: "bash",
        args: ["-lc", "printf 'tmux-ok\\n'; sleep 60"],
      },
    );

    expect(execFileImpl).toHaveBeenCalledWith(
      "tmux",
      [
        "-S",
        "/tmp/runweave-test/tmux.sock",
        "-f",
        "/tmp/runweave-test/tmux.conf",
        "new-session",
        "-d",
        "-s",
        "runweave-terminal-1",
        "-c",
        "/tmp/demo",
        "bash -lc 'printf '\\''tmux-ok\\n'\\''; sleep 60'",
      ],
      expect.any(Object),
    );
  });

  it("reports explicit disablement as unavailable", async () => {
    const execFileImpl = vi.fn();
    const service = createService(execFileImpl, {
      TERMINAL_TMUX_ENABLED: "false",
    });

    await expect(service.isAvailable()).resolves.toBe(false);
    await expect(service.getUnavailableReason()).resolves.toContain(
      "disabled",
    );
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("probes version, create, has-session, and kill-session when available", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "tmux 3.4\n", stderr: "" }));
    const service = createService(execFileImpl);

    await expect(service.isAvailable()).resolves.toBe(true);

    expect(execFileImpl).toHaveBeenCalledWith("tmux", ["-V"], expect.any(Object));
    expect(execFileImpl).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["new-session", "-d"]),
      expect.any(Object),
    );
    expect(execFileImpl).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["has-session"]),
      expect.any(Object),
    );
    expect(execFileImpl).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["kill-session"]),
      expect.any(Object),
    );
  });

  it("captures pane history and exposes duration", async () => {
    const execFileImpl = vi.fn(async () => ({
      stdout: "line-1\nline-2\n",
      stderr: "",
    }));
    const service = createService(execFileImpl);

    await expect(
      service.capturePane({
        sessionName: "runweave-terminal-1",
        socketPath: "/tmp/runweave-test/tmux.sock",
      }),
    ).resolves.toEqual({
      data: "line-1\nline-2\n",
      durationMs: expect.any(Number),
    });
    expect(execFileImpl).toHaveBeenCalledWith(
      "tmux",
      [
        "-S",
        "/tmp/runweave-test/tmux.sock",
        "-f",
        "/tmp/runweave-test/tmux.conf",
        "capture-pane",
        "-p",
        "-J",
        "-S",
        "-5000",
        "-t",
        "runweave-terminal-1",
      ],
      expect.any(Object),
    );
  });

  it("stops tmux rebuild attempts after three attempts in the window", () => {
    let now = 1_000;
    const service = new TmuxService({
      execFile: vi.fn(),
      socketPath: "/tmp/runweave-test/tmux.sock",
      now: () => now,
    });

    expect(service.recordRebuildAttempt("terminal-1").allowed).toBe(true);
    expect(service.recordRebuildAttempt("terminal-1").allowed).toBe(true);
    expect(service.recordRebuildAttempt("terminal-1").allowed).toBe(true);
    expect(() => service.recordRebuildAttempt("terminal-1")).toThrow(
      TmuxRebuildLimitError,
    );

    now += 61_000;
    expect(service.recordRebuildAttempt("terminal-1").allowed).toBe(true);
  });
});
