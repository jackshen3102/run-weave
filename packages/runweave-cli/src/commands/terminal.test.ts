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
    const stdout = { value: "", write(chunk: string) { this.value += chunk; } };
    const stderr = { value: "", write(chunk: string) { this.value += chunk; } };

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
});
