import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { logTerminalPerf } from "./perf-logging";
import { applyShellIntegration } from "./shell-integration";

export interface TmuxTarget {
  sessionName: string;
  socketPath: string;
}

export interface TmuxCommand {
  command: string;
  args: string[];
}

export interface TmuxLaunchCommand {
  command: string;
  args: string[];
}

export interface TmuxPaneMetadata {
  cwd: string;
  activeCommand: string | null;
}

export interface TmuxAvailability {
  available: boolean;
  reason: string | null;
}

export interface TmuxRebuildAttempt {
  allowed: true;
  count: number;
  windowMs: number;
  maxAttempts: number;
}

export type TmuxExecFile = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

interface TmuxServiceOptions {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  socketDir?: string;
  execFile?: TmuxExecFile;
  now?: () => number;
}

const execFileAsync = promisify(nodeExecFile) as TmuxExecFile;
const RUNWEAVE_TMUX_PREFIX = "runweave-";
const TmuxCommandTimeoutMs = 5_000;
const RebuildWindowMs = 60_000;
const MaxRebuildAttempts = 3;
const CaptureHistoryLines = 5_000;
const InteractivePaneReadyMinWaitMs = 1_000;
const InteractivePaneReadyStableMs = 200;
const InteractivePaneReadyTimeoutMs = 2_500;
const TMUX_RUNTIME_OPTION_ARGS = ["set-option", "-g", "mouse", "on"];
const TMUX_METADATA_FIELD_SEPARATOR = "__RUNWEAVE_METADATA_FIELD__";
const SHELL_INTEGRATION_ENV_KEYS = [
  "BROWSER_VIEWER_LAST_COMMAND",
  "BROWSER_VIEWER_ORIGINAL_ZDOTDIR",
  "PROMPT_COMMAND",
  "ZDOTDIR",
];

export class TmuxRebuildLimitError extends Error {
  constructor(
    readonly terminalSessionId: string,
    readonly count: number,
    readonly windowMs: number,
    readonly maxAttempts: number,
  ) {
    super(
      `tmux session rebuild exceeded ${maxAttempts} attempts in ${windowMs} ms for ${terminalSessionId}`,
    );
    this.name = "TmuxRebuildLimitError";
  }
}

export class TmuxService {
  readonly execFileImpl: TmuxExecFile;

  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly rebuildAttempts = new Map<string, number[]>();
  private availability: Promise<TmuxAvailability> | null = null;

  constructor(options?: TmuxServiceOptions) {
    this.env = options?.env ?? process.env;
    this.execFileImpl = options?.execFile ?? execFileAsync;
    this.now = options?.now ?? (() => Date.now());
    this.socketPath =
      options?.socketPath ??
      path.join(
        options?.socketDir ?? os.tmpdir(),
        `runweave-${createHash("sha256")
          .update(process.cwd())
          .digest("hex")
          .slice(0, 8)}.tmux.sock`,
      );
  }

  readonly socketPath: string;

  get configPath(): string {
    return path.join(path.dirname(this.socketPath), "tmux.conf");
  }

  get binary(): string {
    return this.env.TMUX_BINARY?.trim() || "tmux";
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveAvailability()).available;
  }

  async getUnavailableReason(): Promise<string | null> {
    return (await this.resolveAvailability()).reason;
  }

  buildSessionName(terminalSessionId: string): string {
    const safeId = terminalSessionId
      .trim()
      .replace(/\.\.+/g, "-")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
    return `${RUNWEAVE_TMUX_PREFIX}${safeId || "terminal"}`;
  }

  buildTarget(terminalSessionId: string): TmuxTarget {
    return {
      sessionName: this.buildSessionName(terminalSessionId),
      socketPath: this.socketPath,
    };
  }

  async withSessionLock<T>(
    terminalSessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLocks.get(terminalSessionId) ?? Promise.resolve();
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => current);
    this.sessionLocks.set(terminalSessionId, chained);

    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      releaseCurrent();
      if (this.sessionLocks.get(terminalSessionId) === chained) {
        this.sessionLocks.delete(terminalSessionId);
      }
    }
  }

  async hasSession(target: TmuxTarget): Promise<boolean> {
    try {
      await this.runTmux(["has-session", "-t", target.sessionName], target);
      return true;
    } catch (error) {
      if (isProcessExitCode(error, 1)) {
        return false;
      }
      console.error("[viewer-be] tmux has-session failed", {
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        error: String(error),
      });
      return false;
    }
  }

  buildAttachCommand(
    target: TmuxTarget,
    cwd: string,
    launchCommand?: TmuxLaunchCommand,
  ): TmuxCommand {
    return {
      command: this.binary,
      args: [
        ...this.buildServerArgs(target.socketPath),
        ...TMUX_RUNTIME_OPTION_ARGS,
        ";",
        "new-session",
        "-A",
        "-s",
        target.sessionName,
        "-c",
        cwd,
        ...(launchCommand ? [formatShellCommand(launchCommand)] : []),
      ],
    };
  }

  async createDetachedSession(
    target: TmuxTarget,
    cwd: string,
    launchCommand: TmuxLaunchCommand,
  ): Promise<void> {
    await this.runTmux(
      [
        ...TMUX_RUNTIME_OPTION_ARGS,
        ";",
        "new-session",
        "-d",
        "-s",
        target.sessionName,
        ...this.buildShellIntegrationEnvArgs(launchCommand),
        "-c",
        cwd,
        formatShellCommand(launchCommand),
      ],
      target,
    );
  }

  async killSession(target: TmuxTarget): Promise<void> {
    try {
      await this.runTmux(["kill-session", "-t", target.sessionName], target);
    } catch (error) {
      if (isProcessExitCode(error, 1)) {
        return;
      }
      console.error("[viewer-be] tmux kill-session failed", {
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        error: String(error),
      });
    }
  }

  async capturePane(
    target: TmuxTarget,
    historyLines = CaptureHistoryLines,
  ): Promise<{ data: string; durationMs: number; sourceCols?: number }> {
    const startedAt = performance.now();
    const [result, sourceCols] = await Promise.all([
      this.runTmux(
        [
          "capture-pane",
          "-p",
          "-J",
          "-S",
          `-${historyLines}`,
          "-t",
          target.sessionName,
        ],
        target,
      ),
      this.readPaneWidth(target),
    ]);
    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    logTerminalPerf("terminal.tmux.capture-pane", {
      sessionName: target.sessionName,
      durationMs,
      historyLines,
      sourceCols,
      bytes: Buffer.byteLength(result.stdout, "utf8"),
    });
    return {
      data: result.stdout,
      durationMs,
      sourceCols,
    };
  }

  async readPaneMetadata(
    target: TmuxTarget,
    shellCommand?: string,
  ): Promise<TmuxPaneMetadata | null> {
    const result = await this.runTmux(
      [
        "display-message",
        "-p",
        "-t",
        target.sessionName,
        [
          "#{pane_current_path}",
          "#{@runweave_command}",
          "#{pane_current_command}",
        ].join(TMUX_METADATA_FIELD_SEPARATOR),
      ],
      target,
    );
    const [rawCwd = "", rawRunweaveCommand = "", rawCommand = ""] = result.stdout
      .replace(/\r?\n$/, "")
      .split(TMUX_METADATA_FIELD_SEPARATOR);
    const cwd = rawCwd.trim();
    if (!cwd) {
      return null;
    }
    const activeCommand =
      normalizePaneCommand(rawRunweaveCommand) ??
      normalizePaneCommand(rawCommand, shellCommand);
    return {
      cwd,
      activeCommand,
    };
  }

  private async readPaneWidth(target: TmuxTarget): Promise<number | undefined> {
    try {
      const result = await this.runTmux(
        [
          "display-message",
          "-p",
          "-t",
          target.sessionName,
          "#{pane_width}",
        ],
        target,
      );
      const width = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(width) && width > 0 ? width : undefined;
    } catch {
      return undefined;
    }
  }

  async waitForPaneReady(target: TmuxTarget): Promise<void> {
    const startedAt = Date.now();
    let lastCapture = "";
    let stableSince = 0;

    while (Date.now() - startedAt < InteractivePaneReadyTimeoutMs) {
      try {
        const capture = await this.capturePane(target, 80);
        const currentCapture = capture.data.trimEnd();
        if (currentCapture && currentCapture === lastCapture) {
          if (stableSince === 0) {
            stableSince = Date.now();
          }
          if (
            Date.now() - startedAt >= InteractivePaneReadyMinWaitMs &&
            Date.now() - stableSince >= InteractivePaneReadyStableMs
          ) {
            return;
          }
        } else {
          lastCapture = currentCapture;
          stableSince = 0;
        }
      } catch {
        stableSince = 0;
      }
      await delay(100);
    }
  }

  recordRebuildAttempt(terminalSessionId: string): TmuxRebuildAttempt {
    const now = this.now();
    const windowStart = now - RebuildWindowMs;
    const attempts = (this.rebuildAttempts.get(terminalSessionId) ?? []).filter(
      (timestamp) => timestamp >= windowStart,
    );
    if (attempts.length >= MaxRebuildAttempts) {
      this.rebuildAttempts.set(terminalSessionId, attempts);
      throw new TmuxRebuildLimitError(
        terminalSessionId,
        attempts.length + 1,
        RebuildWindowMs,
        MaxRebuildAttempts,
      );
    }

    attempts.push(now);
    this.rebuildAttempts.set(terminalSessionId, attempts);
    return {
      allowed: true,
      count: attempts.length,
      windowMs: RebuildWindowMs,
      maxAttempts: MaxRebuildAttempts,
    };
  }

  private async resolveAvailability(): Promise<TmuxAvailability> {
    if (!this.availability) {
      this.availability = this.probeAvailability();
    }
    return this.availability;
  }

  private async probeAvailability(): Promise<TmuxAvailability> {
    if (this.env.TERMINAL_TMUX_ENABLED?.trim().toLowerCase() === "false") {
      return {
        available: false,
        reason: "tmux disabled by TERMINAL_TMUX_ENABLED=false",
      };
    }
    if (!["darwin", "linux", "freebsd", "openbsd"].includes(process.platform)) {
      return {
        available: false,
        reason: `tmux is unsupported on ${process.platform}`,
      };
    }

    try {
      await this.ensureSocketDirectory();
      if (this.binary.includes(path.sep)) {
        await access(this.binary, constants.X_OK);
      }
      await this.runTmux(["-V"]);
      const probeName = `${RUNWEAVE_TMUX_PREFIX}probe-${process.pid}-${randomUUID()}`;
      const target = {
        sessionName: probeName,
        socketPath: this.socketPath,
      };
      try {
        await this.runTmux(
          ["new-session", "-d", "-s", probeName, "-c", os.homedir()],
          target,
        );
        await this.runTmux(["has-session", "-t", probeName], target);
      } finally {
        await this.killSession(target);
      }
      return { available: true, reason: null };
    } catch (error) {
      return {
        available: false,
        reason: `tmux probe failed: ${String(error)}`,
      };
    }
  }

  private async ensureSocketDirectory(): Promise<void> {
    await mkdir(path.dirname(this.socketPath), { recursive: true });
    await writeFile(
      this.configPath,
      [
        "set-option -g history-limit 5000",
        "set-option -g mouse on",
        "set-option -g default-terminal \"tmux-256color\"",
        "set-option -as terminal-overrides ',xterm-256color:RGB'",
        "unbind-key C-b",
        "set-option -g prefix C-\\\\",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  private buildServerArgs(socketPath: string): string[] {
    return ["-S", socketPath, "-f", this.configPath];
  }

  private buildShellIntegrationEnvArgs(
    launchCommand: TmuxLaunchCommand,
  ): string[] {
    if (launchCommand.args.some((arg) => arg === "-c" || arg === "-lc")) {
      return [];
    }
    const integratedEnv = applyShellIntegration(launchCommand.command, {
      ...this.env,
    });
    return SHELL_INTEGRATION_ENV_KEYS.flatMap((key) => {
      const value = integratedEnv[key];
      if (value === undefined || value === this.env[key]) {
        return [];
      }
      return ["-e", `${key}=${value}`];
    });
  }

  private async runTmux(
    args: string[],
    target?: TmuxTarget,
  ): Promise<{ stdout: string; stderr: string }> {
    await this.ensureSocketDirectory();
    const serverArgs = target
      ? this.buildServerArgs(target.socketPath)
      : this.buildServerArgs(this.socketPath);
    const normalizedArgs =
      args[0] === "-V" ? args : [...serverArgs, ...args];
    return this.execFileImpl(this.binary, normalizedArgs, {
      env: this.env,
      timeout: TmuxCommandTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
}

function isProcessExitCode(error: unknown, exitCode: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === exitCode
  );
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function formatShellCommand(launchCommand: TmuxLaunchCommand): string {
  return [launchCommand.command, ...launchCommand.args]
    .map((part) => shellQuote(part))
    .join(" ");
}

function normalizePaneCommand(
  paneCommand: string,
  shellCommand?: string,
): string | null {
  const command = paneCommand.trim();
  if (!command) {
    return null;
  }

  const shellName = shellCommand ? path.basename(shellCommand) : null;
  if (shellName && isInteractiveShellName(shellName) && command === shellName) {
    return null;
  }

  return command;
}

function isInteractiveShellName(command: string): boolean {
  return ["bash", "zsh", "sh", "fish"].includes(command);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
