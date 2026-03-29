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
      name: "xterm-color",
      cols: 120,
      rows: 40,
      cwd: "/tmp/demo",
      env: expect.any(Object),
    });
    expect(runtime.pid).toBe(123);
  });
});
