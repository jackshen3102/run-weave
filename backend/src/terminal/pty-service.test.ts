import { describe, expect, it, vi } from "vitest";
import { PtyService } from "./pty-service";
import backendPackageJson from "../../package.json";

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

  it("adds locale and terminal program metadata when they are missing", () => {
    const ptyProcess = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 654,
    };
    const spawn = vi.fn(() => ptyProcess);
    const service = new PtyService({ spawn });

    const previousLang = process.env.LANG;
    const previousTermProgram = process.env.TERM_PROGRAM;
    const previousTermProgramVersion = process.env.TERM_PROGRAM_VERSION;
    delete process.env.LANG;
    delete process.env.TERM_PROGRAM;
    delete process.env.TERM_PROGRAM_VERSION;

    try {
      service.spawnSession({
        command: "bash",
        cwd: "/tmp/demo",
      });
    } finally {
      process.env.LANG = previousLang;
      process.env.TERM_PROGRAM = previousTermProgram;
      process.env.TERM_PROGRAM_VERSION = previousTermProgramVersion;
    }

    expect(spawn).toHaveBeenCalledWith(
      "bash",
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          LANG: "en_US.UTF-8",
          TERM_PROGRAM: "browser-viewer",
          TERM_PROGRAM_VERSION: backendPackageJson.version,
        }),
      }),
    );
  });

  it("does not leak inherited host secrets into the shell environment", () => {
    const ptyProcess = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 777,
    };
    const spawn = vi.fn(() => ptyProcess);
    const service = new PtyService({ spawn });

    const previousGoogleApiKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "host-secret";

    try {
      service.spawnSession({
        command: "bash",
        cwd: "/tmp/demo",
      });
    } finally {
      if (previousGoogleApiKey === undefined) {
        delete process.env.GOOGLE_API_KEY;
      } else {
        process.env.GOOGLE_API_KEY = previousGoogleApiKey;
      }
    }

    expect(spawn).toHaveBeenCalledWith(
      "bash",
      [],
      expect.objectContaining({
        env: expect.not.objectContaining({
          GOOGLE_API_KEY: "host-secret",
        }),
      }),
    );
  });

  it("removes AppImage PATH pollution before spawning the shell", () => {
    const ptyProcess = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 888,
    };
    const spawn = vi.fn(() => ptyProcess);
    const service = new PtyService({ spawn });

    const previousAppImage = process.env.APPIMAGE;
    const previousAppDir = process.env.APPDIR;
    const previousPath = process.env.PATH;
    process.env.APPIMAGE = "/Applications/browser-viewer.AppImage";
    process.env.APPDIR = "/tmp/.mount_browser_viewer";
    process.env.PATH = [
      "/usr/local/bin",
      "/tmp/.mount_browser_viewer/usr/bin",
      "/usr/bin",
    ].join(":");

    try {
      service.spawnSession({
        command: "bash",
        cwd: "/tmp/demo",
      });
    } finally {
      if (previousAppImage === undefined) {
        delete process.env.APPIMAGE;
      } else {
        process.env.APPIMAGE = previousAppImage;
      }
      if (previousAppDir === undefined) {
        delete process.env.APPDIR;
      } else {
        process.env.APPDIR = previousAppDir;
      }
      process.env.PATH = previousPath;
    }

    expect(spawn).toHaveBeenCalledWith(
      "bash",
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: "/usr/local/bin:/usr/bin",
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

  it("falls back to a safe shell when the configured shell exits immediately", () => {
    vi.useFakeTimers();
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
    const fallbackDataListeners: Array<(data: string) => void> = [];
    const fallbackExitListeners: Array<
      (event: { exitCode: number; signal?: number }) => void
    > = [];
    const firstPty = {
      onData: vi.fn((listener: (data: string) => void) => {
        dataListeners.push(listener);
      }),
      onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListeners.push(listener);
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 111,
    };
    const fallbackPty = {
      onData: vi.fn((listener: (data: string) => void) => {
        fallbackDataListeners.push(listener);
      }),
      onExit: vi.fn(
        (listener: (event: { exitCode: number; signal?: number }) => void) => {
          fallbackExitListeners.push(listener);
        },
      ),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 222,
    };
    const spawn = vi.fn()
      .mockReturnValueOnce(firstPty)
      .mockReturnValueOnce(fallbackPty);
    const service = new PtyService({ spawn });
    const runtime = service.spawnSession({
      command: "/bad-shell",
      args: ["--broken"],
      cwd: "/tmp/demo",
      fallback: {
        command: "/bin/zsh",
        args: ["-l"],
      },
    });
    const received: string[] = [];
    const exits: Array<{ exitCode: number; signal?: number }> = [];

    runtime.onData((data) => {
      received.push(data);
    });
    runtime.onExit((event) => {
      exits.push(event);
    });

    exitListeners[0]?.({ exitCode: 1 });
    fallbackDataListeners[0]?.("ready\r\n");

    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "/bin/zsh",
      ["-l"],
      expect.objectContaining({
        cwd: "/tmp/demo",
      }),
    );
    expect(received.join("")).toContain("using fallback shell config");
    expect(received.join("")).toContain("ready");
    expect(exits).toEqual([]);
    vi.useRealTimers();
  });

  it("falls back when the initial shell cannot be spawned", () => {
    const fallbackPty = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 333,
    };
    const spawn = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("spawn ENOENT");
      })
      .mockReturnValueOnce(fallbackPty);
    const service = new PtyService({ spawn });

    const runtime = service.spawnSession({
      command: "/bad-shell",
      cwd: "/tmp/demo",
      fallback: {
        command: "/bin/bash",
        args: ["-l"],
      },
    });

    expect(runtime.pid).toBe(333);
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "/bin/bash",
      ["-l"],
      expect.objectContaining({
        cwd: "/tmp/demo",
      }),
    );
  });
});
