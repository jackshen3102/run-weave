import type {
  KillOrphanedTmuxSessionsOptions,
  TmuxCommand,
  TmuxLaunchCommand,
  TmuxRebuildAttempt,
  TmuxSessionInfo,
  TmuxTarget,
} from "./tmux-types";
import { TmuxRebuildLimitError } from "./tmux-types";
import { TmuxProcess } from "./tmux-process";
import {
  MaxRebuildAttempts,
  RebuildWindowMs,
  RUNWEAVE_TMUX_PREFIX,
  TMUX_RUNTIME_OPTION_ARGS,
  TMUX_SANITIZE_NPM_PREFIX_ENV_ARGS,
  formatShellCommand,
  isProcessExitCode,
  parsePositiveInteger,
  tmuxLogger,
} from "./tmux-internals";

export class TmuxSessionService extends TmuxProcess {
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
    const previous =
      this.sessionLocks.get(terminalSessionId) ?? Promise.resolve();
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
      tmuxLogger.error("terminal.tmux.has-session.failed", {
        message: "Tmux has-session failed",
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        error,
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
        ...TMUX_SANITIZE_NPM_PREFIX_ENV_ARGS,
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
        ...TMUX_SANITIZE_NPM_PREFIX_ENV_ARGS,
        ...TMUX_RUNTIME_OPTION_ARGS,
        ";",
        "new-session",
        "-d",
        "-s",
        target.sessionName,
        ...this.buildShellIntegrationEnvArgs(launchCommand),
        ...this.buildLaunchEnvArgs(launchCommand.env),
        ...this.buildExtraEnvArgs(),
        "-c",
        cwd,
        formatShellCommand(launchCommand),
      ],
      target,
    );
  }

  async syncSessionEnvironment(
    target: TmuxTarget,
    env: Record<string, string | undefined>,
  ): Promise<void> {
    const args = Object.entries(env).flatMap(([key, value]) =>
      value
        ? ["set-environment", "-t", target.sessionName, key, value, ";"]
        : ["set-environment", "-t", target.sessionName, "-u", key, ";"],
    );
    if (args.length === 0) {
      return;
    }
    await this.runTmux(args.slice(0, -1), target);
  }

  async readSessionEnvironment(
    target: TmuxTarget,
  ): Promise<Record<string, string>> {
    const result = await this.runTmux(
      ["show-environment", "-t", target.sessionName],
      target,
    );
    return Object.fromEntries(
      result.stdout
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("-"))
        .map((line) => {
          const separatorIndex = line.indexOf("=");
          return separatorIndex < 0
            ? [line, ""]
            : [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
        }),
    );
  }

  async killSession(target: TmuxTarget): Promise<void> {
    try {
      await this.runTmux(["kill-session", "-t", target.sessionName], target);
    } catch (error) {
      if (isProcessExitCode(error, 1)) {
        return;
      }
      tmuxLogger.error("terminal.tmux.kill-session.failed", {
        message: "Tmux kill-session failed",
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        error,
      });
    }
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      const result = await this.runTmux([
        "list-sessions",
        "-F",
        ["#{session_name}", "#{session_attached}", "#{session_windows}"].join(
          "\t",
        ),
      ]);
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [sessionName = "", rawAttached = "0", rawWindows = "0"] =
            line.split("\t");
          return {
            sessionName,
            attachedClients: parsePositiveInteger(rawAttached),
            windows: parsePositiveInteger(rawWindows),
          };
        })
        .filter((session) =>
          session.sessionName.startsWith(RUNWEAVE_TMUX_PREFIX),
        );
    } catch (error) {
      if (isProcessExitCode(error, 1)) {
        return [];
      }
      throw error;
    }
  }

  async listOrphanedSessions(
    knownSessionNames: ReadonlySet<string>,
  ): Promise<TmuxSessionInfo[]> {
    const sessions = await this.listSessions();
    return sessions.filter(
      (session) => !knownSessionNames.has(session.sessionName),
    );
  }

  async killOrphanedSessions(
    knownSessionNames: ReadonlySet<string>,
    options?: KillOrphanedTmuxSessionsOptions,
  ): Promise<TmuxSessionInfo[]> {
    const orphanedSessions = (
      await this.listOrphanedSessions(knownSessionNames)
    ).filter(
      (session) => options?.includeAttached || session.attachedClients === 0,
    );
    for (const session of orphanedSessions) {
      await this.killSession({
        sessionName: session.sessionName,
        socketPath: this.socketPath,
      });
    }
    return orphanedSessions;
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
}
