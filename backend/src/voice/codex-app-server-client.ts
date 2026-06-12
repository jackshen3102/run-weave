import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../logging";

interface CodexRpcSuccess {
  id: string;
  result?: unknown;
  payload?: unknown;
}

interface CodexRpcFailure {
  id: string;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

type CodexRpcResponse = CodexRpcSuccess | CodexRpcFailure;

interface CodexRequestWaiter {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const codexAppServerLogger = logger.child({
  component: "voice-codex-app-server",
});
const CODEX_APP_SERVER_ARGS = ["app-server"] as const;

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private waiters = new Map<string, CodexRequestWaiter>();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (method !== "initialize" && method !== "initialized") {
      await this.ensureInitialized();
    }
    return this.writeRequest(method, params);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.writeRequest("initialize", {
      clientInfo: {
        name: "runweave_voice_probe",
        title: "Runweave Voice Probe",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    })
      .then(() => {
        this.initialized = true;
        this.sendNotification("initialized", null);
      })
      .catch((error) => {
        if (error.message.toLowerCase().includes("already initialized")) {
          this.initialized = true;
          return;
        }
        throw error;
      })
      .finally(() => {
        this.initializePromise = null;
      });

    return this.initializePromise;
  }

  private writeRequest(method: string, params?: unknown): Promise<unknown> {
    const child = this.ensureChild();
    const id = `runweave-voice-${this.nextRequestId++}`;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 20_000);

      this.waiters.set(id, {
        method,
        resolve,
        reject,
        timeout,
      });

      try {
        child.stdin.write(`${message}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.waiters.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const child = this.ensureChild();
    if (
      !child.stdin.writable ||
      child.stdin.destroyed ||
      child.stdin.writableEnded
    ) {
      return;
    }
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  shutdown(): void {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.initializePromise = null;
    this.failAll(new Error("Codex app-server stopped."));
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (
      this.child &&
      this.child.exitCode === null &&
      !this.child.killed &&
      this.child.stdin.writable
    ) {
      return this.child;
    }

    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    const launchPlan = resolveCodexLaunchPlan(process.env);
    this.child = spawn(launchPlan.command, launchPlan.args, {
      env: buildCodexProcessEnv(process.env, launchPlan),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("spawn", () => {
      codexAppServerLogger.info("voice.codex-app-server.started", {
        message: "Codex app-server started for voice transcription",
        launchCommand: launchPlan.description,
      });
    });
    this.child.on("error", (error) => {
      codexAppServerLogger.warn("voice.codex-app-server.error", {
        message: "Codex app-server failed",
        error,
      });
      this.failAll(error);
      this.child = null;
      this.initialized = false;
      this.initializePromise = null;
    });
    this.child.on("close", (code, signal) => {
      const details = this.stderrBuffer.trim();
      codexAppServerLogger.warn("voice.codex-app-server.closed", {
        message: "Codex app-server closed",
        code,
        signal,
        stderr: details || null,
      });
      this.failAll(
        new Error(
          details ||
            `Codex app-server exited with code ${code}${signal ? ` (${signal})` : ""}.`,
        ),
      );
      this.child = null;
      this.initialized = false;
      this.initializePromise = null;
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf8"));
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf8")}`.slice(
        -4_096,
      );
    });

    return this.child;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: CodexRpcResponse | null = null;
    try {
      parsed = JSON.parse(line) as CodexRpcResponse;
    } catch {
      codexAppServerLogger.debug("voice.codex-app-server.non-json-output", {
        message: "Ignored non-JSON Codex app-server output",
      });
      return;
    }

    const id = typeof parsed?.id === "string" ? parsed.id : "";
    const waiter = this.waiters.get(id);
    if (!waiter) {
      return;
    }

    this.waiters.delete(id);
    clearTimeout(waiter.timeout);

    if ("error" in parsed && parsed.error) {
      const error = new Error(
        parsed.error.message ||
          `Codex app-server request failed: ${waiter.method}`,
      );
      waiter.reject(error);
      return;
    }

    const success = parsed as CodexRpcSuccess;
    if (Object.prototype.hasOwnProperty.call(success, "result")) {
      waiter.resolve(success.result ?? null);
      return;
    }
    waiter.resolve(success.payload ?? null);
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

export const codexAppServerClient = new CodexAppServerClient();

interface CodexLaunchPlan {
  command: string;
  args: string[];
  description: string;
}

function resolveCodexLaunchPlan(env: NodeJS.ProcessEnv): CodexLaunchPlan {
  const configured = env.CODEX_BIN?.trim();
  if (configured && isExecutableFile(configured)) {
    return {
      command: configured,
      args: [...CODEX_APP_SERVER_ARGS],
      description: configured,
    };
  }

  for (const candidate of resolveCodexBinaryCandidates(env)) {
    if (isExecutableFile(candidate)) {
      return {
        command: candidate,
        args: [...CODEX_APP_SERVER_ARGS],
        description: candidate,
      };
    }
  }

  return {
    command: "codex",
    args: [...CODEX_APP_SERVER_ARGS],
    description: "codex",
  };
}

function buildCodexProcessEnv(
  env: NodeJS.ProcessEnv,
  launchPlan: CodexLaunchPlan,
): NodeJS.ProcessEnv {
  const launchDir = path.dirname(launchPlan.command);
  const currentPath = env.PATH ?? "";
  const pathEntries = [launchDir, ...currentPath.split(path.delimiter)]
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    ...env,
    PATH: Array.from(new Set(pathEntries)).join(path.delimiter),
  };
}

function resolveCodexBinaryCandidates(env: NodeJS.ProcessEnv): string[] {
  const homeDir = os.homedir();
  const pathCandidates = (env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.join(entry, "codex"));
  return Array.from(
    new Set([
      ...pathCandidates,
      path.join(homeDir, ".volta", "bin", "codex"),
      path.join(homeDir, ".local", "bin", "codex"),
      path.join(homeDir, ".npm-global", "bin", "codex"),
      ...resolveNvmCodexCandidates(path.join(homeDir, ".nvm", "versions", "node")),
    ]),
  );
}

function resolveNvmCodexCandidates(nodeVersionsDir: string): string[] {
  try {
    return readdirSync(nodeVersionsDir)
      .map((entry) => path.join(nodeVersionsDir, entry, "bin", "codex"))
      .sort((left, right) => readMtimeMs(right) - readMtimeMs(left));
  } catch {
    return [];
  }
}

function readMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}
