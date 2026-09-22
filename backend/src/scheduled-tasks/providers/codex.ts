import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  parseScheduledResult,
  scheduledPrompt,
  scheduledResultSchema,
} from "./result";
import type {
  ScheduledProviderAdapter,
  ScheduledProviderRequest,
  ScheduledProviderResult,
} from "./types";

const TERMINATION_GRACE_MS = 3_000;

export class CodexScheduledTaskProvider implements ScheduledProviderAdapter {
  readonly provider = "codex" as const;

  constructor(
    private readonly binary = process.env.RUNWEAVE_CODEX_BIN?.trim() || "codex",
    private readonly autoReviewSupported = false,
  ) {}

  async run(
    request: ScheduledProviderRequest,
  ): Promise<ScheduledProviderResult> {
    if (request.signal.aborted) throw new Error("provider_cancelled");
    if (request.executionPolicy === "auto-review" && !this.autoReviewSupported)
      throw new Error("execution_policy_unavailable");
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "runweave-scheduled-result-"),
    );
    try {
      const schemaPath = path.join(directory, "result-schema.json");
      await writeFile(schemaPath, JSON.stringify(scheduledResultSchema), {
        mode: 0o600,
      });
      return await this.runWithSchema(request, schemaPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async runWithSchema(
    request: ScheduledProviderRequest,
    schemaPath: string,
  ): Promise<ScheduledProviderResult> {
    if (request.signal.aborted) throw new Error("provider_cancelled");
    const args = [
      "exec",
      ...(request.executionPolicy === "auto-review"
        ? ["--approve-for-me"]
        : [
            "--sandbox",
            "workspace-write",
            "--config",
            'approval_policy="never"',
          ]),
      "--config",
      "sandbox_workspace_write.network_access=false",
      "--output-schema",
      schemaPath,
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "--cd",
      request.workingDirectory,
      ...(request.model ? ["--model", request.model] : []),
      ...(request.effort
        ? [
            "--config",
            `model_reasoning_effort=${JSON.stringify(request.effort)}`,
          ]
        : []),
      "-",
    ];
    const child = spawn(this.binary, args, {
      cwd: request.workingDirectory,
      env: providerEnvironment(process.env, request.runId),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const exitPromise = waitForExit(child);
    const terminate = createTermination(child);
    if (!child.pid) {
      terminate("provider_spawn_failed");
      await exitPromise;
      throw new Error("provider_spawn_failed");
    }
    try {
      await request.onSpawn(child.pid);
    } catch (error) {
      terminate("provider_owner_persist_failed");
      await exitPromise;
      throw error;
    }
    if (request.signal.aborted) {
      terminate("provider_cancelled");
      await exitPromise;
      throw new Error("provider_cancelled");
    }
    const timeout = setTimeout(
      () => terminate("provider_timeout"),
      request.maxWallTimeMs,
    );
    timeout.unref();
    const onAbort = (): void => terminate("provider_cancelled");
    request.signal.addEventListener("abort", onAbort, { once: true });
    child.stdin.on("error", () => terminate("provider_stdin_failed"));
    child.stdin.end(scheduledPrompt(request.prompt, request.runId));

    let threadId = "";
    let summary = "";
    let completed = false;
    let outputBytes = 0;
    let writeQueue = Promise.resolve(true);
    const enqueue = (action: () => Promise<boolean>): void => {
      writeQueue = writeQueue
        .then((accepted) => (accepted ? action() : false))
        .then(
          (accepted) => {
            if (!accepted) terminate("provider_output_limit_exceeded");
            return accepted;
          },
          () => {
            terminate("provider_output_persist_failed");
            return false;
          },
        );
    };
    let parseBuffer = "";
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const capture = (source: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maxOutputBytes) {
        terminate("provider_output_limit_exceeded");
        return;
      }
      const text = decoders[source].write(chunk);
      enqueue(() => request.onOutput(text));
      if (source === "stdout") {
        parseBuffer += text;
        const lines = parseBuffer.split(/\r?\n/u);
        parseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseEvent(line);
          if (!event) continue;
          if (
            event.type === "thread.started" &&
            typeof event.thread_id === "string"
          ) {
            threadId = event.thread_id;
            const startedThreadId = threadId;
            enqueue(async () => {
              await request.onThread(startedThreadId);
              return true;
            });
          }
          if (event.type === "item.completed" && isAgentMessage(event.item))
            summary = event.item.text;
          if (event.type === "turn.completed") completed = true;
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

    try {
      const exit = await exitPromise;
      if (parseBuffer.trim()) {
        const event = parseEvent(parseBuffer);
        if (
          event?.type === "thread.started" &&
          typeof event.thread_id === "string"
        ) {
          threadId = event.thread_id;
          await request.onThread(threadId);
        }
        if (event?.type === "item.completed" && isAgentMessage(event.item))
          summary = event.item.text;
        if (event?.type === "turn.completed") completed = true;
      }
      const outputAccepted = await writeQueue;
      const reason = terminationReasons.get(child);
      if (reason) throw new Error(reason);
      if (!outputAccepted) throw new Error("provider_output_limit_exceeded");
      if (exit.error) throw exit.error;
      if (exit.code !== 0) throw new Error("provider_exit_nonzero");
      if (!threadId) throw new Error("provider_thread_missing");
      if (!completed) throw new Error("provider_completion_missing");
      return {
        provider: this.provider,
        threadId,
        ...parseScheduledResult(summary),
      };
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

function providerEnvironment(
  source: NodeJS.ProcessEnv,
  runId: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...source,
    RUNWEAVE_SCHEDULED_TASK_RUN_ID: runId,
  };
  for (const key of [
    "AUTH_USERNAME",
    "AUTH_PASSWORD",
    "AUTH_JWT_SECRET",
    "RUNWEAVE_HOOK_TOKEN",
    "RUNWEAVE_PUSH_SENDER_TOKEN",
    "RUNWEAVE_SNAPSHOT_UPLOAD_TOKEN",
    "RUNWEAVE_TERMINAL_SESSION_ID",
    "RUNWEAVE_TERMINAL_PANEL_ID",
    "RUNWEAVE_TERMINAL_AGENT_OPERATION_ID",
    "RUNWEAVE_AGENT_TEAM_RUN_ID",
    "RUNWEAVE_AGENT_TEAM_WORKER_ID",
    "RUNWEAVE_TMUX_SESSION_NAME",
    "TMUX",
    "TMUX_PANE",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "RUNWEAVE_APP_SERVER_TOKEN",
  ])
    delete env[key];
  return env;
}

function parseEvent(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isAgentMessage(
  value: unknown,
): value is { type: "agent_message"; text: string } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "agent_message" && typeof record.text === "string";
}

const terminationReasons = new WeakMap<ChildProcess, string>();
function createTermination(child: ChildProcess): (reason: string) => void {
  return (reason) => {
    if (child.exitCode !== null || terminationReasons.has(child)) return;
    terminationReasons.set(child, reason);
    terminateProcessGroup(child, "SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null) terminateProcessGroup(child, "SIGKILL");
    }, TERMINATION_GRACE_MS);
    force.unref();
  };
}

function terminateProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolve({ code: null, error });
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ code });
      }
    });
  });
}
