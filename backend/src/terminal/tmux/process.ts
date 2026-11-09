import { resolveTerminalFallbackLaunchConfig, type TerminalLaunchConfig } from "../runtime/default-shell";
import { configuration, settingText } from "@runweave/config-node";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizeTerminalProcessEnv } from "../runtime/env";
import { applyShellIntegration } from "../runtime/shell-integration";
import { TmuxShellStartupError } from "./types";
import type {
  TmuxAvailability,
  TmuxExecFile,
  TmuxLaunchCommand,
  TmuxServiceOptions,
  TmuxTarget,
} from "./types";
import {
  RUNWEAVE_TMUX_PREFIX,
  SHELL_INTEGRATION_ENV_KEYS,
  TmuxCommandTimeoutMs,
  categorizeTmuxCommand,
  isTimeoutError,
  isInteractiveShellLaunchCommand,
  isUnsetEnvValue,
  isUtf8Locale,
  resolveExecutableFromPath,
  formatShellCommand,
  shellQuote,
  delay,
  resolveUtf8Locale,
  tmuxLogger,
} from "./internals";

const execFileAsync = promisify(nodeExecFile) as TmuxExecFile;

export abstract class TmuxProcess {
  readonly execFileImpl: TmuxExecFile;

  protected readonly env: NodeJS.ProcessEnv;
  protected readonly now: () => number;
  protected readonly sessionLocks = new Map<string, Promise<void>>();
  protected readonly rebuildAttempts = new Map<string, number[]>();
  private availability: Promise<TmuxAvailability> | null = null;

  constructor(options?: TmuxServiceOptions) {
    this.env = sanitizeTerminalProcessEnv(options?.env ?? process.env);
    this.execFileImpl = options?.execFile ?? execFileAsync;
    this.now = options?.now ?? (() => Date.now());
    this.socketPath =
      options?.socketPath ??
      path.join(options?.socketDir ?? path.join(configuration().context.configRoot, "runtime"), "tmux.sock");
  }

  readonly socketPath: string;

  get configPath(): string {
    return path.join(path.dirname(this.socketPath), "tmux.conf");
  }

  get binary(): string {
    return resolveExecutableFromPath(
      settingText("terminal.tmux.binary")?.trim() || "tmux",
      this.env,
    );
  }

  abstract killSession(target: TmuxTarget): Promise<void>;

  async isAvailable(): Promise<boolean> {
    return (await this.resolveAvailability()).available;
  }

  async getUnavailableReason(): Promise<string | null> {
    return (await this.resolveAvailability()).reason;
  }

  private async resolveAvailability(): Promise<TmuxAvailability> {
    if (!this.availability) {
      this.availability = this.probeAvailability();
    }
    return this.availability;
  }

  private async probeAvailability(): Promise<TmuxAvailability> {
    if (settingText("terminal.tmux.enabled")?.trim().toLowerCase() === "false") {
      return {
        available: false,
        reason: "tmux disabled by configuration",
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
      tmuxLogger.error("terminal.tmux.availability.probe.failed", {
        message: "Tmux availability probe failed",
        socketPath: this.socketPath,
        error,
      });
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
        'set-option -g default-terminal "tmux-256color"',
        "set-option -as terminal-overrides ',xterm-256color:RGB'",
        "unbind-key C-b",
        "set-option -g prefix C-\\\\",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  protected buildServerArgs(socketPath: string): string[] {
    return ["-S", socketPath, "-f", this.configPath];
  }

  protected buildShellIntegrationEnvArgs(
    launchCommand: TmuxLaunchCommand,
  ): string[] {
    if (!isInteractiveShellLaunchCommand(launchCommand)) {
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

  protected buildLaunchEnvArgs(
    env: Record<string, string | undefined> | undefined,
  ): string[] {
    if (!env) {
      return [];
    }

    return Object.entries(env).flatMap(([key, value]) => {
      if (!value) {
        return [];
      }
      return ["-e", `${key}=${value}`];
    });
  }

  /**
   * Inject extra env vars into tmux sessions that may not be present
   * in the tmux server's cached global environment.
   */
  protected buildExtraEnvArgs(): string[] {
    const args: string[] = [];
    const currentPath = this.env.PATH;
    if (currentPath) {
      args.push("-e", `PATH=${currentPath}`);
    }
    const nvmDir = this.env.NVM_DIR;
    if (nvmDir) {
      args.push("-e", `NVM_DIR=${nvmDir}`);
    }
    const cdpEndpoint = this.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
    if (cdpEndpoint) {
      args.push("-e", `PLAYWRIGHT_MCP_CDP_ENDPOINT=${cdpEndpoint}`);
    }
    const utf8Locale = resolveUtf8Locale(this.env);
    args.push(
      "-e",
      `LANG=${isUtf8Locale(this.env.LANG) ? this.env.LANG!.trim() : utf8Locale}`,
    );
    args.push(
      "-e",
      `LC_CTYPE=${isUtf8Locale(this.env.LC_CTYPE) ? this.env.LC_CTYPE!.trim() : utf8Locale}`,
    );
    if (!isUnsetEnvValue(this.env.LC_ALL)) {
      args.push(
        "-e",
        `LC_ALL=${isUtf8Locale(this.env.LC_ALL) ? this.env.LC_ALL!.trim() : utf8Locale}`,
      );
    }
    args.push("-e", `COLORTERM=${this.env.COLORTERM?.trim() || "truecolor"}`);
    return args;
  }

  /** Called only for a newly allocated pane, before it is exposed to input. */
  protected async startShellInPane(
    target: TmuxTarget & { paneId: string }, cwd: string, launch: TmuxLaunchCommand,
    fallback: TerminalLaunchConfig,
  ): Promise<TmuxLaunchCommand & { fallbackReason?: string }> {
    const spawn = (next: TmuxLaunchCommand, message?: string) => this.runTmux([
      "respawn-pane", "-k", "-t", target.paneId, "-c", cwd,
      ...this.buildShellIntegrationEnvArgs(next), ...this.buildLaunchEnvArgs(next.env),
      message ? `printf '%s\\r\\n' ${shellQuote(message)}; exec ${formatShellCommand(next)}` : formatShellCommand(next),
    ], target);
    const wait = async (): Promise<number | null> => {
      const deadline = Date.now() + 1000;
      do {
        const result = await this.runTmux(["display-message", "-p", "-t", target.paneId, "#{pane_dead}:#{pane_dead_status}"], target, { sensitiveOutput: true });
        const [dead, status] = result.stdout.trim().split(":");
        if (dead === "1") return Number(status);
        await delay(100);
      } while (Date.now() < deadline);
      return null;
    };
    try {
      await this.runTmux(["set-option", "-p", "-t", target.paneId, "remain-on-exit", "on"], target);
      let actual: TmuxLaunchCommand & { fallbackReason?: string } = launch;
      await spawn(launch);
      const exit = await wait();
      if (exit !== null) {
        if (exit === 0) throw new Error("Shell exited during startup (code 0)");
        const message = `Runweave: shell exited with code ${exit}; using system default ${fallback.command}`;
        actual = { ...fallback, env: launch.env, fallbackReason: message };
        tmuxLogger.warn("terminal.tmux.shell-fallback", { message, command: launch.command, fallbackCommand: fallback.command, paneId: target.paneId });
        await spawn(actual, message);
        const fallbackExit = await wait();
        if (fallbackExit !== null) throw new Error(`System shell exited during startup (code ${fallbackExit})`);
      }
      await this.runTmux(["set-option", "-p", "-u", "-t", target.paneId, "remain-on-exit"], target);
      return actual;
    } catch (error) {
      await this.runTmux(["kill-pane", "-t", target.paneId], target).catch(cleanupError => {
        tmuxLogger.warn("terminal.tmux.shell-startup.cleanup-failed", { paneId: target.paneId, error: cleanupError });
      });
      throw new TmuxShellStartupError(error);
    }
  }

  protected shellFallback(launch: TmuxLaunchCommand): TerminalLaunchConfig | null {
    return resolveTerminalFallbackLaunchConfig(launch);
  }

  protected async runTmux(
    args: string[],
    target?: TmuxTarget,
    options?: { sensitiveOutput?: boolean },
  ): Promise<{ stdout: string; stderr: string }> {
    await this.ensureSocketDirectory();
    const serverArgs = target
      ? this.buildServerArgs(target.socketPath)
      : this.buildServerArgs(this.socketPath);
    const normalizedArgs = args[0] === "-V" ? args : [...serverArgs, ...args];
    try {
      return await this.execFileImpl(this.binary, normalizedArgs, {
        env: this.env,
        timeout: TmuxCommandTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        tmuxLogger.error("terminal.tmux.command.timeout", {
          message: "Tmux command timed out",
          commandCategory: categorizeTmuxCommand(args),
          sessionName: target?.sessionName,
          socketPath: target?.socketPath ?? this.socketPath,
          timeoutMs: TmuxCommandTimeoutMs,
          ...(options?.sensitiveOutput ? {} : { error }),
        });
      }
      throw error;
    }
  }
}
