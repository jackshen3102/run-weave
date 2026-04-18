import type { TerminalSessionManager, TerminalSessionRecord } from "./manager";
import { resolveTerminalFallbackLaunchConfig } from "./default-shell";
import type { PtyRuntime, PtyService } from "./pty-service";
import type { TerminalRuntimeRegistry } from "./runtime-registry";
import { createTerminalRuntimeRecorder } from "./runtime-recorder";
import type { TmuxService, TmuxTarget } from "./tmux-service";
import { TmuxRebuildLimitError } from "./tmux-service";

export interface EnsureTerminalRuntimeResult {
  runtime: PtyRuntime;
  warning?: string;
}

interface EnsureTerminalRuntimeOptions {
  session: TerminalSessionRecord;
  terminalSessionManager: TerminalSessionManager;
  runtimeRegistry: TerminalRuntimeRegistry;
  ptyService: PtyService;
  tmuxService?: TmuxService;
  allowMissingTmuxSession?: boolean;
}

const TmuxPostEnterInputDelayMs = 300;

export function isTmuxBackedSession(
  session: Pick<TerminalSessionRecord, "runtimeKind">,
): boolean {
  return session.runtimeKind === "tmux";
}

export function resolveTmuxTarget(
  session: TerminalSessionRecord,
  tmuxService: TmuxService,
): TmuxTarget {
  return {
    sessionName: session.tmuxSessionName ?? tmuxService.buildSessionName(session.id),
    socketPath: session.tmuxSocketPath ?? tmuxService.socketPath,
  };
}

export async function ensureTerminalRuntime(
  options: EnsureTerminalRuntimeOptions,
): Promise<EnsureTerminalRuntimeResult> {
  const existingRuntime = options.runtimeRegistry.getRuntime(options.session.id);
  if (existingRuntime) {
    return { runtime: existingRuntime };
  }

  if (isTmuxBackedSession(options.session) && options.tmuxService) {
    return options.tmuxService.withSessionLock(options.session.id, async () => {
      const existingLockedRuntime = options.runtimeRegistry.getRuntime(
        options.session.id,
      );
      if (existingLockedRuntime) {
        return { runtime: existingLockedRuntime };
      }

      const currentSession =
        options.terminalSessionManager.getSession(options.session.id) ??
        options.session;
      const target = resolveTmuxTarget(currentSession, options.tmuxService!);
      const hasSession = await options.tmuxService!.hasSession(target);
      let warning: string | undefined;

      if (!hasSession && !options.allowMissingTmuxSession) {
        try {
          const attempt = options.tmuxService!.recordRebuildAttempt(
            currentSession.id,
          );
          warning =
            `Original tmux session was lost; created a fresh terminal session (${attempt.count}/${attempt.maxAttempts}).`;
          console.error("[viewer-be] tmux terminal session missing; rebuilding", {
            terminalSessionId: currentSession.id,
            sessionName: target.sessionName,
            socketPath: target.socketPath,
            rebuildCount: attempt.count,
            rebuildWindowMs: attempt.windowMs,
          });
        } catch (error) {
          if (error instanceof TmuxRebuildLimitError) {
            await options.terminalSessionManager.updateRuntimeMetadata(
              currentSession.id,
              {
                runtimeKind: "tmux",
                tmuxSessionName: target.sessionName,
                tmuxSocketPath: target.socketPath,
                recoverable: false,
              },
            );
            options.terminalSessionManager.markExited(currentSession.id, 1);
          }
          throw error;
        }
      }

      if (!hasSession) {
        await options.tmuxService!.createDetachedSession(
          target,
          currentSession.cwd,
          {
            command: currentSession.command,
            args: currentSession.args,
          },
        );
        if (
          isInteractiveShellLaunch(currentSession.command, currentSession.args)
        ) {
          await options.tmuxService!.waitForPaneReady(target);
        }
      }

      const attachCommand = options.tmuxService!.buildAttachCommand(
        target,
        currentSession.cwd,
      );
      const runtime = createTmuxInputPacedRuntime(
        options.ptyService.spawnSession({
          command: attachCommand.command,
          args: attachCommand.args,
          cwd: currentSession.cwd,
          fallback: null,
        }),
      );
      options.runtimeRegistry.createRuntime(currentSession.id, runtime);
      return { runtime, warning };
    });
  }

  const runtime = options.ptyService.spawnSession({
    command: options.session.command,
    args: options.session.args,
    cwd: options.session.cwd,
    fallback: resolveTerminalFallbackLaunchConfig({
      command: options.session.command,
      args: options.session.args,
    }),
    onFallbackActivated: (fallback) => {
      void options.terminalSessionManager.updateSessionLaunch(
        options.session.id,
        fallback,
      );
    },
  });
  options.runtimeRegistry.createRuntime(options.session.id, runtime);
  options.runtimeRegistry.ensureRecorder(
    options.session.id,
    createTerminalRuntimeRecorder(
      options.terminalSessionManager,
      options.session.id,
    ),
  );
  return { runtime };
}

function isInteractiveShellLaunch(command: string, args: string[]): boolean {
  const commandName = command.split(/[\\/]/).at(-1) ?? command;
  if (!["bash", "zsh", "sh", "fish"].includes(commandName)) {
    return false;
  }
  return !args.some((arg) => arg === "-c" || arg === "-lc");
}

function createTmuxInputPacedRuntime(runtime: PtyRuntime): PtyRuntime {
  const queuedInput: string[] = [];
  let holdInputUntil = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const scheduleFlush = (delayMs: number): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushInput();
    }, delayMs);
  };

  const flushInput = (): void => {
    if (disposed || queuedInput.length === 0) {
      return;
    }

    const delayMs = holdInputUntil - Date.now();
    if (delayMs > 0) {
      scheduleFlush(delayMs);
      return;
    }

    const next = queuedInput.shift();
    if (next === undefined) {
      return;
    }

    runtime.write(next);
    if (/[\r\n]/.test(next)) {
      holdInputUntil = Date.now() + TmuxPostEnterInputDelayMs;
    }
    if (queuedInput.length > 0) {
      scheduleFlush(0);
    }
  };

  return {
    get pid() {
      return runtime.pid;
    },
    onData(listener) {
      runtime.onData(listener);
    },
    onExit(listener) {
      runtime.onExit(listener);
    },
    write(data) {
      for (const chunk of splitInputAtLineBreaks(data)) {
        queuedInput.push(chunk);
      }
      flushInput();
    },
    resize(cols, rows) {
      runtime.resize(cols, rows);
    },
    signal(signal) {
      runtime.signal(signal);
    },
    dispose() {
      disposed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      queuedInput.length = 0;
      runtime.dispose();
    },
  };
}

function splitInputAtLineBreaks(data: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === "\r" || data[index] === "\n") {
      if (index > start) {
        chunks.push(data.slice(start, index));
      }
      chunks.push(data[index] ?? "");
      start = index + 1;
    }
  }
  if (start < data.length) {
    chunks.push(data.slice(start));
  }
  return chunks.length > 0 ? chunks : [data];
}

export async function readTerminalScrollback(
  session: TerminalSessionRecord,
  terminalSessionManager: TerminalSessionManager,
  tmuxService: TmuxService | undefined,
  mode: "history" | "live",
): Promise<string> {
  if (isTmuxBackedSession(session) && tmuxService) {
    try {
      const captured = await tmuxService.capturePane(
        resolveTmuxTarget(session, tmuxService),
      );
      return captured.data;
    } catch (error) {
      console.error("[viewer-be] tmux capture-pane failed", {
        terminalSessionId: session.id,
        tmuxSessionName: session.tmuxSessionName,
        tmuxSocketPath: session.tmuxSocketPath,
        error: String(error),
      });
      return "";
    }
  }

  if (mode === "history") {
    return terminalSessionManager.readScrollback(session.id);
  }
  return terminalSessionManager.readLiveScrollback(session.id);
}

export async function killTmuxSessionForTerminal(
  session: TerminalSessionRecord,
  tmuxService: TmuxService | undefined,
): Promise<void> {
  if (!isTmuxBackedSession(session) || !tmuxService) {
    return;
  }
  await tmuxService.killSession(resolveTmuxTarget(session, tmuxService));
}
