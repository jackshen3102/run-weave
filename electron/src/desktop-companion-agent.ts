import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type {
  AttentionOpenIntent,
  AttentionOpenResult,
  CompanionPresentationState,
} from "@runweave/shared/attention";

type CompanionFrontendSource =
  | { kind: "dev"; url: string }
  | { kind: "bundle"; root: string };

interface DesktopCompanionAgentOptions {
  frontend: CompanionFrontendSource;
  onOpenSlot: (intent: AttentionOpenIntent) => Promise<AttentionOpenResult>;
  statePath: string;
}

interface CompanionAgentMessage {
  type?: unknown;
  pid?: unknown;
  commandId?: unknown;
  intent?: unknown;
  message?: unknown;
}

const READY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 1_500;

function resolveExecutablePath(): string {
  const configured = process.env.RUNWEAVE_COMPANION_AGENT_EXECUTABLE?.trim();
  if (configured) return path.resolve(configured);
  const runtimeRoot = app.isPackaged ? process.resourcesPath : __dirname;
  return path.join(
    runtimeRoot,
    "companion",
    "Runweave Companion.app",
    "Contents",
    "MacOS",
    "Runweave Companion",
  );
}

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["LANG", "LC_ALL", "PATH", "TMPDIR"].flatMap((key) => {
      const value = process.env[key];
      return value ? [[key, value]] : [];
    }),
  );
}

export class DesktopCompanionAgent {
  private child: ChildProcessWithoutNullStreams | null = null;
  private desiredRunning = false;
  private latestPresentation: CompanionPresentationState | null = null;
  private outputBuffer = "";
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private starting: Promise<void> | null = null;

  constructor(private readonly options: DesktopCompanionAgentOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): Promise<void> {
    this.desiredRunning = true;
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.sendTo(child, { type: "shutdown" });
    child.stdin.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", finish);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        finish();
      }, STOP_TIMEOUT_MS);
    });
  }

  publish(presentation: CompanionPresentationState): void {
    this.latestPresentation = presentation;
    if (this.child) {
      this.sendTo(this.child, { type: "presentation", presentation });
    }
  }

  private async launch(): Promise<void> {
    const executable = resolveExecutablePath();
    await access(executable);
    if (!this.desiredRunning) return;
    const child = spawn(executable, [], {
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.outputBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.readOutput(chunk));
    child.stderr.on("data", (chunk: string) => {
      console.warn("[companion-agent]", chunk.trimEnd());
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (!this.desiredRunning) return;
      console.warn("[companion-agent] exited unexpectedly", { code, signal });
      this.scheduleRestart();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.child === child) child.kill("SIGTERM");
        reject(new Error("Companion agent readiness timed out"));
      }, READY_TIMEOUT_MS);
      const handleReady = (message: CompanionAgentMessage): void => {
        if (message.type !== "ready") return;
        clearTimeout(timer);
        this.onMessage = this.handleMessage.bind(this);
        resolve();
      };
      this.onMessage = handleReady;
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Companion agent exited before readiness"));
      });
    });
    if (this.child !== child || !this.desiredRunning) return;
    this.restartAttempt = 0;
    this.sendTo(child, {
      type: "bootstrap",
      frontend: this.options.frontend,
      statePath: this.options.statePath,
    });
    if (this.latestPresentation) {
      this.sendTo(child, {
        type: "presentation",
        presentation: this.latestPresentation,
      });
    }
  }

  private onMessage: (message: CompanionAgentMessage) => void = () => {};

  private readOutput(chunk: string): void {
    this.outputBuffer += chunk;
    for (;;) {
      const newline = this.outputBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.outputBuffer.slice(0, newline).trim();
      this.outputBuffer = this.outputBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as CompanionAgentMessage);
      } catch {
        console.warn("[companion-agent] ignored malformed output");
      }
    }
  }

  private handleMessage(message: CompanionAgentMessage): void {
    if (message.type === "openSlot") {
      if (
        typeof message.commandId !== "string" ||
        !message.intent ||
        typeof message.intent !== "object"
      ) {
        return;
      }
      const commandId = message.commandId;
      const child = this.child;
      if (!child) return;
      void this.options
        .onOpenSlot(message.intent as AttentionOpenIntent)
        .then((result) => {
          if (this.child === child) {
            this.sendTo(child, {
              type: "openResult",
              commandId,
              result,
            });
          }
        })
        .catch((error) => {
          console.error("[companion-agent] open request failed", error);
        });
      return;
    }
    if (message.type === "navigationError" || message.type === "scriptError") {
      console.warn("[companion-agent]", message.type, message.message);
    }
  }

  private sendTo(
    child: ChildProcessWithoutNullStreams,
    command: Record<string, unknown>,
  ): void {
    if (!child.stdin.destroyed)
      child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.desiredRunning) return;
    const delay = Math.min(500 * 2 ** this.restartAttempt, 10_000);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((error) => {
        console.error("[companion-agent] restart failed", error);
        this.scheduleRestart();
      });
    }, delay);
  }
}
