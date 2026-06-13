import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../index.js";
import { inferHandoffWorkloadState } from "./terminal.js";

describe("inferHandoffWorkloadState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not treat an agent foreground command alone as running", () => {
    expect(
      inferHandoffWorkloadState(
        {
          activeCommand: "codex",
          command: "/bin/zsh",
          status: "running",
        },
        "last output without reliable activity markers",
      ),
    ).toMatchObject({
      inferredWorkloadState: "unknown",
      foregroundCommand: "codex",
      stateConfidence: "low",
      stateReasons: [
        "activeCommand=codex",
        "no reliable prompt/running detection available",
      ],
    });
  });

  it("reports an agent waiting for input when an agent prompt is visible", () => {
    expect(
      inferHandoffWorkloadState(
        {
          activeCommand: "codex",
          command: "/bin/zsh",
          status: "running",
        },
        "› ",
      ),
    ).toMatchObject({
      inferredWorkloadState: "agent_waiting_input",
      stateConfidence: "medium",
      stateReasons: ["activeCommand=codex", "tail contains an agent prompt"],
    });
  });

  it("reports agent running only when activity markers are present", () => {
    expect(
      inferHandoffWorkloadState(
        {
          activeCommand: "codex",
          command: "/bin/zsh",
          status: "running",
        },
        "• Working on the requested change",
      ),
    ).toMatchObject({
      inferredWorkloadState: "agent_running",
      stateConfidence: "medium",
      stateReasons: [
        "activeCommand=codex",
        "tail contains agent activity markers",
      ],
    });
  });

  it("sends terminal input through the HTTP API", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith("/api/terminal/session/terminal-1")) {
          return Response.json({
            terminalSessionId: "terminal-1",
            projectId: "project-1",
            command: "bash",
            args: [],
            cwd: "/tmp/demo",
            activeCommand: null,
            scrollback: "",
            status: "running",
            createdAt: "2026-05-05T00:00:00.000Z",
          });
        }
        if (url.endsWith("/api/terminal/session/terminal-1/input")) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            data: "pwd\r",
          });
          return Response.json({
            operationId: "op-test-1",
            terminalSessionId: "terminal-1",
            inputAccepted: true,
            inputEnqueued: true,
            runtimeKind: "pty",
            acceptedAt: "2026-05-05T00:00:01.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      [
        "terminal",
        "send",
        "terminal-1",
        "--text",
        "pwd",
        "--enter",
        "--confirm",
        "none",
        "--json",
      ],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(requestedUrls).toEqual([
      "http://127.0.0.1:5001/api/terminal/session/terminal-1",
      "http://127.0.0.1:5001/api/terminal/session/terminal-1/input",
      "http://127.0.0.1:5001/api/terminal/session/terminal-1",
    ]);
    expect(JSON.parse(stdout.value)).toMatchObject({
      operationId: "op-test-1",
      terminalSessionId: "terminal-1",
      transport: "http",
      inputAccepted: true,
      inputEnqueued: true,
      runtimeKind: "pty",
    });
  });

  it("creates a terminal with command args and inherited context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/terminal/session")) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            command: "codex",
            args: ["--model", "gpt-5"],
            inheritFromTerminalSessionId: "terminal-parent",
            runtimePreference: "auto",
          });
          return Response.json({
            terminalSessionId: "terminal-2",
            projectId: "project-1",
            command: "codex",
            args: ["--model", "gpt-5"],
            cwd: "/tmp/demo",
            status: "running",
            createdAt: "2026-05-05T00:00:00.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      [
        "terminal",
        "create",
        "--inherit-from",
        "terminal-parent",
        "--command",
        "codex",
        "--arg",
        "--model",
        "--arg=gpt-5",
        "--json",
      ],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toMatchObject({
      terminalSessionId: "terminal-2",
    });
  });

  it("returns a usage error when create --arg is missing a value", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      [
        "terminal",
        "create",
        "--project-id",
        "project-1",
        "--cwd",
        "/tmp/demo",
        "--arg",
      ],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Missing value for --arg");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends line mode input without appending an extra carriage return", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/terminal/session/terminal-1")) {
          return Response.json({
            terminalSessionId: "terminal-1",
            projectId: "project-1",
            command: "bash",
            args: [],
            cwd: "/tmp/demo",
            activeCommand: null,
            scrollback: "",
            status: "running",
            createdAt: "2026-05-05T00:00:00.000Z",
          });
        }
        if (url.endsWith("/api/terminal/session/terminal-1/input")) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            data: "pwd",
            mode: "line",
          });
          return Response.json({
            operationId: "op-test-2",
            terminalSessionId: "terminal-1",
            inputAccepted: true,
            inputEnqueued: true,
            runtimeKind: "pty",
            acceptedAt: "2026-05-05T00:00:01.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      [
        "terminal",
        "send",
        "terminal-1",
        "--text",
        "pwd",
        "--mode",
        "line",
        "--enter",
        "--confirm",
        "none",
        "--json",
      ],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toMatchObject({
      terminalSessionId: "terminal-1",
      inputAccepted: true,
      submitted: true,
    });
  });

  it("reads the current terminal state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/terminal/session/terminal-1/state")) {
          return Response.json({
            terminalState: {
              state: "agent_running",
              agent: "codex",
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      ["terminal", "state", "terminal-1", "--json"],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toMatchObject({
      terminalSessionId: "terminal-1",
      terminalState: {
        state: "agent_running",
        agent: "codex",
      },
    });
  });

  it("reads terminal history and prints a requested tail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/terminal/session/terminal-1/history")) {
          return Response.json({
            terminalSessionId: "terminal-1",
            projectId: "project-1",
            command: "bash",
            args: [],
            cwd: "/tmp/demo",
            activeCommand: null,
            scrollback: "one\ntwo\nthree\n",
            status: "running",
            createdAt: "2026-05-05T00:00:00.000Z",
            lastActivityAt: "2026-05-05T00:00:01.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      ["terminal", "history", "terminal-1", "--tail", "2", "--json"],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toMatchObject({
      terminalSessionId: "terminal-1",
      tail: "two\nthree",
    });
  });

  it("deletes a terminal session by id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/terminal/session/terminal-1")) {
          expect(init?.method).toBe("DELETE");
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      ["terminal", "delete", "terminal-1", "--json"],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toEqual({
      terminalSessionId: "terminal-1",
      deleted: true,
    });
  });

  it("interrupts terminal input through the HTTP API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/terminal/session/terminal-1/interrupt")) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            operationId: expect.stringMatching(/^op_/),
          });
          return Response.json({
            operationId: "op-interrupt-1",
            terminalSessionId: "terminal-1",
            inputAccepted: true,
            inputEnqueued: true,
            interruptAccepted: true,
            interruptSequence: "escape",
            runtimeKind: "pty",
            acceptedAt: "2026-05-05T00:00:01.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      ["terminal", "interrupt", "terminal-1", "--json"],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toMatchObject({
      operationId: "op-interrupt-1",
      terminalSessionId: "terminal-1",
      transport: "http",
      inputAccepted: true,
      inputEnqueued: true,
      interruptAccepted: true,
      interruptSequence: "escape",
      runtimeKind: "pty",
    });
  });

  it("uses current terminal state for terminal handoff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/terminal/project")) {
          return Response.json([
            {
              projectId: "project-1",
              name: "Demo",
              path: "/tmp/demo",
              createdAt: "2026-06-09T00:00:00.000Z",
              isDefault: true,
            },
          ]);
        }
        if (url.endsWith("/api/terminal/session")) {
          return Response.json([
            {
              terminalSessionId: "terminal-1",
              projectId: "project-1",
              command: "bash",
              args: [],
              cwd: "/tmp/demo",
              activeCommand: "codex",
              status: "running",
              createdAt: "2026-06-09T00:00:00.000Z",
              lastActivityAt: "2026-06-09T00:00:01.000Z",
            },
          ]);
        }
        if (url.endsWith("/api/terminal/session/terminal-1")) {
          return Response.json({
            terminalSessionId: "terminal-1",
            projectId: "project-1",
            command: "bash",
            args: [],
            cwd: "/tmp/demo",
            activeCommand: "codex",
            scrollback: "last output without activity markers",
            status: "running",
            createdAt: "2026-06-09T00:00:00.000Z",
            lastActivityAt: "2026-06-09T00:00:01.000Z",
          });
        }
        if (url.endsWith("/api/terminal/session/terminal-1/state")) {
          return Response.json({
            terminalState: {
              state: "agent_running",
              agent: "codex",
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };

    const exitCode = await runCli(
      ["terminal", "handoff", "terminal-1", "--json"],
      {
        stdout,
        stderr,
        stdin: process.stdin,
        env: {
          RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
          RUNWEAVE_ACCESS_TOKEN: "access-token",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toMatchObject({
      terminalState: "agent_running",
      agent: "codex",
      inferredAgent: "codex",
      inferredState: "agent_running",
      inferredWorkloadState: "agent_running",
      stateConfidence: "strong",
      stateReasons: [
        "terminalState=agent_running",
        "agent=codex",
        "activeCommand=codex",
      ],
    });
  });
});
