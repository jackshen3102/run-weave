import { describe, expect, it, vi } from "vitest";
import { PtyService } from "./pty-service";

describe("PtyService", () => {
  it("spawns a PTY session with the provided command and args", () => {
    const ptyProcess = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 123,
    };
    const spawn = vi.fn(() => ptyProcess);
    const service = new PtyService({ spawn });

    const runtime = service.spawnSession({
      command: "bash",
      args: ["-l"],
      cwd: "/tmp/demo",
      cols: 120,
      rows: 40,
    });

    expect(spawn).toHaveBeenCalledWith("bash", ["-l"], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: "/tmp/demo",
      env: expect.any(Object),
    });
    expect(runtime.pid).toBe(123);
  });

  it("uses vim-friendly terminal env defaults when TERM is missing", () => {
    const ptyProcess = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 321,
    };
    const spawn = vi.fn(() => ptyProcess);
    const service = new PtyService({ spawn });

    const previousTerm = process.env.TERM;
    const previousColorTerm = process.env.COLORTERM;
    delete process.env.TERM;
    delete process.env.COLORTERM;

    try {
      service.spawnSession({
        command: "bash",
        cwd: "/tmp/demo",
      });
    } finally {
      process.env.TERM = previousTerm;
      process.env.COLORTERM = previousColorTerm;
    }

    expect(spawn).toHaveBeenCalledWith(
      "bash",
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        }),
      }),
    );
  });

  it("injects zsh shell integration so prompt refresh can publish cwd metadata", () => {
    const ptyProcess = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 555,
    };
    const spawn = vi.fn(() => ptyProcess);
    const service = new PtyService({ spawn });

    service.spawnSession({
      command: "/bin/zsh",
      cwd: "/tmp/demo",
    });

    expect(spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          ZDOTDIR: expect.stringContaining("browser-viewer-zsh"),
          BROWSER_VIEWER_ORIGINAL_ZDOTDIR: expect.any(String),
        }),
      }),
    );
  });
});
