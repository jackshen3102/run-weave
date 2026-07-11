import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizeTerminalProcessEnv } from "./env";
import { applyShellIntegration } from "./shell-integration";
import type {
  TmuxAvailability,
  TmuxExecFile,
  TmuxLaunchCommand,
  TmuxServiceOptions,
  TmuxTarget,
} from "./tmux-types";
import {
  RUNWEAVE_TMUX_PREFIX,
  SHELL_INTEGRATION_ENV_KEYS,
  TmuxCommandTimeoutMs,
  categorizeTmuxCommand,
  isTimeoutError,
  isUnsetEnvValue,
  isUtf8Locale,
  resolveExecutableFromPath,
  resolveUtf8Locale,
  tmuxLogger,
} from "./tmux-internals";

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
    return resolveExecutableFromPath(
      this.env.TMUX_BINARY?.trim() || "tmux",
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

  protected async runTmux(
    args: string[],
    target?: TmuxTarget,
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
          error,
        });
      }
      throw error;
    }
  }
}
