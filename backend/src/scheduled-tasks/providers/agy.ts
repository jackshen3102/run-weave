import { resolveAgyConfiguration } from "@runweave/config-node/agy";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

export class AgyScheduledTaskProvider implements ScheduledProviderAdapter {
  readonly provider = "agy" as const;

  constructor(
    private readonly binary = resolveAgyConfiguration().binary,
    private readonly autoReviewSupported = false,
    private readonly fullAccessSupported = false,
  ) {}

  async run(
    request: ScheduledProviderRequest,
  ): Promise<ScheduledProviderResult> {
    if (request.signal.aborted) throw new Error("provider_cancelled");
    if (request.executionPolicy === "auto-review" && !this.autoReviewSupported) {
      throw new Error("execution_policy_unavailable");
    }
    if (request.executionPolicy === "full-access" && !this.fullAccessSupported) {
      throw new Error("execution_policy_unavailable");
    }
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "runweave-scheduled-agy-result-"),
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
    const policyArgs =
      request.executionPolicy === "full-access"
        ? ["--dangerously-skip-permissions"]
        : request.executionPolicy === "auto-review"
          ? ["--mode", "auto"]
          : ["--sandbox"];
    const args = [
      "-p",
      scheduledPrompt(request.prompt, request.runId),
      "--output-format",
      "stream-json",
      "--json-schema",
      schemaPath,
      ...policyArgs,
      ...(request.model ? ["--model", request.model] : []),
      ...(request.effort ? ["--effort", request.effort] : []),
      ...(request.resumeThreadId ? ["--resume", request.resumeThreadId] : []),
    ];
    const child = spawn(this.binary, args, {
      cwd: request.workingDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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

    let threadId = request.resumeThreadId ?? "";
    let lastText = "";
    let resultPayload: unknown = null;
    let outputBytes = 0;
    let truncated = false;

    const handleLine = async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) return;
      outputBytes += Buffer.byteLength(trimmed);
      if (outputBytes <= request.maxOutputBytes) {
        await request.onOutput(`${trimmed}\n`);
      } else if (!truncated) {
        truncated = true;
      }
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        const cid =
          (typeof event.conversationId === "string" && event.conversationId) ||
          (typeof event.conversation_id === "string" && event.conversation_id) ||
          (typeof event.session_id === "string" && event.session_id) ||
          "";
        if (cid && cid !== threadId) {
          threadId = cid;
          await request.onThread(threadId);
        }
        if (typeof event.result === "string") {
          lastText = event.result;
          try {
            resultPayload = JSON.parse(event.result);
          } catch {
            // Non-JSON text result; handled below.
          }
        } else if (event.result && typeof event.result === "object") {
          resultPayload = event.result;
        } else if (typeof event.content === "string" && event.content.trim()) {
          lastText = event.content;
        }
      } catch {
        // Ignore non-JSON diagnostic lines.
      }
    };

    const stdoutDecoder = new StringDecoder("utf8");
    let buffer = "";
    const lineQueue: Promise<void>[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += stdoutDecoder.write(chunk);
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        lineQueue.push(handleLine(line));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (outputBytes < request.maxOutputBytes) {
        outputBytes += Buffer.byteLength(text);
        void request.onOutput(text);
      }
    });

    try {
      const exitCode = await exitPromise;
      buffer += stdoutDecoder.end();
      if (buffer.trim()) lineQueue.push(handleLine(buffer));
      await Promise.all(lineQueue);
      if (exitCode !== 0) {
        return {
          provider: this.provider,
          threadId,
          summary: lastText || `agy exited with code ${exitCode}`,
          outcome: "failed",
          reason: `agy_exit_${exitCode}`,
        };
      }
      const parsed = parseScheduledResult(
        resultPayload ? JSON.stringify(resultPayload) : lastText,
      );
      return {
        provider: this.provider,
        threadId,
        summary: parsed.summary,
        outcome: parsed.outcome,
        reason: parsed.reason,
      };
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
}

function createTermination(child: ChildProcess): (reason: string) => void {
  let sent = false;
  return () => {
    if (sent) return;
    sent = true;
    try {
      if (child.pid && process.platform !== "win32") {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Ignore already-exited child.
      }
    }, TERMINATION_GRACE_MS);
    timer.unref();
  };
}
