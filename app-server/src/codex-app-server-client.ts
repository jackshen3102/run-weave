import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AppServerCodexThreadDetail,
  AppServerThreadDetailResponse,
  AppServerThreadDetailTurn,
  AppServerThreadRef,
} from "@runweave/shared/app-server-events";
import {
  asRecord,
  isExecutableFile,
  isPresent,
  normalizeDate,
  normalizeDetailStatus,
  readMtimeMs,
  readNonNegativeNumber,
  readString,
} from "./codex-app-server-helpers.js";

export type CodexThreadStatusType =
  | "notLoaded"
  | "idle"
  | "systemError"
  | "active";

export interface CodexThreadStatusReader {
  readThreadStatus(
    threadId: string,
    options?: { cwd?: string | null },
  ): Promise<CodexThreadStatusType | null>;
  shutdown(): void;
}

export interface CodexThreadDetailReader {
  readThreadDetail(
    thread: AppServerThreadRef,
  ): Promise<AppServerThreadDetailResponse>;
}

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

interface CodexThreadReadResponse {
  thread?: {
    status?: {
      type?: unknown;
    };
  };
}

const CODEX_SKIP_UPDATE_ON_STARTUP_ARGS = [
  "-c",
  "check_for_update_on_startup=false",
] as const;
const CODEX_APP_SERVER_ARGS = ["app-server"] as const;
const CODEX_THREAD_STATUS_TYPES = new Set<CodexThreadStatusType>([
  "notLoaded",
  "idle",
  "systemError",
  "active",
]);

export class CodexAppServerClient
  implements CodexThreadStatusReader, CodexThreadDetailReader
{
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private waiters = new Map<string, CodexRequestWaiter>();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;

  async readThreadStatus(
    threadId: string,
    options: { cwd?: string | null } = {},
  ): Promise<CodexThreadStatusType | null> {
    let response: CodexThreadReadResponse | null = null;
    try {
      response = (await this.sendRequest("thread/read", {
        threadId,
        includeTurns: false,
      })) as CodexThreadReadResponse | null;
    } catch (error) {
      if (!isCodexThreadUnavailableError(error)) {
        throw error;
      }
    }
    const status = normalizeStatusType(response?.thread?.status?.type);
    if (status !== "notLoaded") {
      return status;
    }
    let resumed: CodexThreadReadResponse | null = null;
    try {
      resumed = (await this.sendRequest("thread/resume", {
        threadId,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      })) as CodexThreadReadResponse | null;
    } catch (error) {
      if (isCodexThreadUnavailableError(error)) {
        return "notLoaded";
      }
      throw error;
    }
    return normalizeStatusType(resumed?.thread?.status?.type);
  }

  async readThreadDetail(
    thread: AppServerThreadRef,
  ): Promise<AppServerThreadDetailResponse> {
    if (thread.agent !== "codex") {
      return { thread, availability: "provider_unsupported" };
    }
    try {
      const response = await this.sendRequest("thread/read", {
        threadId: thread.threadId,
        includeTurns: true,
      });
      const detail = normalizeCodexThreadDetail(response, thread);
      return detail
        ? { thread, availability: "available", detail }
        : { thread, availability: "thread_not_found" };
    } catch (error) {
      return {
        thread,
        availability: isCodexThreadNotFoundError(error)
          ? "thread_not_found"
          : "provider_unavailable",
      };
    }
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

  private async sendRequest(
    method: string,
    params?: unknown,
  ): Promise<unknown> {
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
        name: "runweave_app_server",
        title: "Runweave App Server",
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
    const id = `runweave-app-server-${this.nextRequestId++}`;
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

    this.child.on("error", (error) => {
      this.failAll(error);
      this.child = null;
      this.initialized = false;
      this.initializePromise = null;
    });
    this.child.on("close", (code, signal) => {
      const details = this.stderrBuffer.trim();
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
      waiter.reject(
        new Error(
          parsed.error.message ||
            `Codex app-server request failed: ${waiter.method}`,
        ),
      );
      return;
    }

    const success = parsed as CodexRpcSuccess;
    waiter.resolve(
      Object.prototype.hasOwnProperty.call(success, "result")
        ? (success.result ?? null)
        : (success.payload ?? null),
    );
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

interface CodexLaunchPlan {
  command: string;
  args: string[];
}

function resolveCodexLaunchPlan(env: NodeJS.ProcessEnv): CodexLaunchPlan {
  const args = buildCodexAppServerArgs();
  const configured = env.CODEX_BIN?.trim();
  if (configured && isExecutableFile(configured)) {
    return {
      command: configured,
      args,
    };
  }

  for (const candidate of resolveCodexBinaryCandidates(env)) {
    if (isExecutableFile(candidate)) {
      return {
        command: candidate,
        args,
      };
    }
  }

  return {
    command: "codex",
    args,
  };
}

function buildCodexAppServerArgs(): string[] {
  return [...CODEX_SKIP_UPDATE_ON_STARTUP_ARGS, ...CODEX_APP_SERVER_ARGS];
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
      ...resolveNvmCodexCandidates(
        path.join(homeDir, ".nvm", "versions", "node"),
      ),
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

function normalizeStatusType(value: unknown): CodexThreadStatusType | null {
  return typeof value === "string" &&
    CODEX_THREAD_STATUS_TYPES.has(value as CodexThreadStatusType)
    ? (value as CodexThreadStatusType)
    : null;
}

function isCodexThreadUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread not loaded:|no rollout found for thread id/i.test(message);
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread not loaded:|no rollout found for thread id|thread not found/i.test(
    message,
  );
}

function normalizeCodexThreadDetail(
  response: unknown,
  ref: AppServerThreadRef,
): AppServerCodexThreadDetail | null {
  const root = asRecord(response);
  const thread = asRecord(root?.thread);
  if (!thread) {
    return null;
  }
  const turns = Array.isArray(thread.turns)
    ? thread.turns.map(normalizeTurn).filter(isPresent)
    : [];
  const createdAt = normalizeDate(thread.createdAt) ?? ref.lastActivityAt;
  const updatedAt = normalizeDate(thread.updatedAt) ?? ref.updatedAt;
  const preview =
    readString(thread.preview) ??
    turns.flatMap((turn) => turn.messages).find((message) => message.role === "user")
      ?.text ??
    "";
  return {
    provider: "codex",
    threadId: readString(thread.id) ?? ref.threadId,
    preview,
    status:
      normalizeStatusType(asRecord(thread.status)?.type ?? thread.status) ??
      normalizeDetailStatus(ref.status),
    createdAt,
    updatedAt,
    turns,
  };
}

function normalizeTurn(value: unknown, index: number): AppServerThreadDetailTurn | null {
  const turn = asRecord(value);
  if (!turn) {
    return null;
  }
  const id = readString(turn.id) ?? `turn-${index + 1}`;
  const items = Array.isArray(turn.items) ? turn.items : [];
  const startedAt =
    normalizeDate(turn.startedAt) ?? normalizeDate(turn.createdAt) ?? undefined;
  const completedAt =
    normalizeDate(turn.completedAt) ?? normalizeDate(turn.updatedAt) ?? undefined;
  const durationMs =
    readNonNegativeNumber(turn.durationMs) ??
    (startedAt && completedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
      : undefined);
  return {
    id,
    status: normalizeTurnStatus(turn.status),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    itemsView: normalizeItemsView(turn.itemsView, items.length),
    itemCount: items.length,
    messages: items.flatMap((item, itemIndex) =>
      normalizeMessage(item, `${id}:${itemIndex + 1}`),
    ),
  };
}

function normalizeMessage(
  value: unknown,
  fallbackId: string,
): AppServerThreadDetailTurn["messages"] {
  const item = asRecord(value);
  if (!item) {
    return [];
  }
  const type = readString(item.type);
  const role = readString(item.role);
  const normalizedRole =
    type === "userMessage" || role === "user"
      ? "user"
      : type === "agentMessage" || role === "assistant"
        ? "assistant"
        : null;
  if (!normalizedRole) {
    return [];
  }
  const text = readMessageText(item);
  if (!text) {
    return [];
  }
  return [
    {
      id: readString(item.id) ?? fallbackId,
      role: normalizedRole,
      text,
    },
  ];
}

function readMessageText(item: Record<string, unknown>): string | null {
  const direct = readString(item.text);
  if (direct) {
    return direct;
  }
  const content = item.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.flatMap((part) => {
    if (typeof part === "string") {
      return part.trim() ? [part] : [];
    }
    const record = asRecord(part);
    const text = record
      ? readString(record.text) ?? readString(record.inputText)
      : null;
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function normalizeTurnStatus(
  value: unknown,
): AppServerThreadDetailTurn["status"] {
  const raw = readString(asRecord(value)?.type ?? value)?.toLowerCase();
  if (raw === "completed") return "completed";
  if (raw === "interrupted" || raw === "cancelled" || raw === "canceled") {
    return "interrupted";
  }
  if (raw === "failed" || raw === "systemerror") return "failed";
  return "inProgress";
}

function normalizeItemsView(
  value: unknown,
  itemCount: number,
): AppServerThreadDetailTurn["itemsView"] {
  const raw = readString(value);
  return raw === "notLoaded" || raw === "summary" || raw === "full"
    ? raw
    : itemCount > 0
      ? "full"
      : "notLoaded";
}
