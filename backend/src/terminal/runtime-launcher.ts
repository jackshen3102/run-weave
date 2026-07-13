import type { TerminalSessionManager, TerminalSessionRecord } from "./manager";
import { logger } from "../logging";
import {
  resolveDefaultTerminalLaunchConfig,
  resolveTerminalFallbackLaunchConfig,
} from "./default-shell";
import type { PtyRuntime, PtyService } from "./pty-service";
import type { TerminalRuntimeRegistry } from "./runtime-registry";
import { createTerminalRuntimeRecorder } from "./runtime-recorder";
import type { TmuxService, TmuxTarget } from "./tmux-service";
import type { TmuxOutputWatcher } from "./tmux-output-watcher";
import { TmuxRebuildLimitError } from "./tmux-service";
import { getAgentForCommand } from "./terminal-state-service";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";

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
  tmuxOutputWatcher?: TmuxOutputWatcher;
  allowMissingTmuxSession?: boolean;
}

const TmuxPostEnterInputDelayMs = 300;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const CODEX_SKIP_UPDATE_ON_STARTUP_ARGS = [
  "-c",
  "check_for_update_on_startup=false",
] as const;
const terminalLogger = logger.child({ component: "terminal" });

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
    sessionName:
      session.tmuxSessionName ?? tmuxService.buildSessionName(session.id),
    socketPath: session.tmuxSocketPath ?? tmuxService.socketPath,
  };
}

export async function ensureTerminalRuntime(
  options: EnsureTerminalRuntimeOptions,
): Promise<EnsureTerminalRuntimeResult> {
  const existingRuntime = options.runtimeRegistry.getRuntime(
    options.session.id,
  );
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

      let currentSession =
        options.terminalSessionManager.getSession(options.session.id) ??
        options.session;
      const target = resolveTmuxTarget(currentSession, options.tmuxService!);
      const hasSession = await options.tmuxService!.hasSession(target);
      const wasInteractiveShellLaunch = isInteractiveShellLaunch(
        currentSession.command,
        currentSession.args,
      );
      const agentThreadToResume =
        !hasSession &&
        !options.allowMissingTmuxSession &&
        wasInteractiveShellLaunch
          ? resolveAgentThreadToResume(currentSession)
          : null;
      let warning: string | undefined;

      if (!hasSession && !options.allowMissingTmuxSession) {
        if (agentThreadToResume) {
          try {
            const attempt = options.tmuxService!.recordRebuildAttempt(
              currentSession.id,
            );
            warning = `Original tmux session was lost; resumed ${agentThreadToResume.provider} thread from saved threadId (${attempt.count}/${attempt.maxAttempts}).`;
            terminalLogger.warn(
              "terminal.tmux.session-missing.agent-resume",
              {
                message: "Tmux terminal session missing; resuming agent thread",
                terminalSessionId: currentSession.id,
                provider: agentThreadToResume.provider,
                threadId: agentThreadToResume.threadId,
                sessionName: target.sessionName,
                socketPath: target.socketPath,
                rebuildCount: attempt.count,
                rebuildWindowMs: attempt.windowMs,
              },
            );
          } catch (error) {
            if (error instanceof TmuxRebuildLimitError) {
              terminalLogger.error("terminal.tmux.rebuild-limit.exceeded", {
                message: "Tmux rebuild limit exceeded",
                terminalSessionId: currentSession.id,
                count: error.count,
                windowMs: error.windowMs,
                maxAttempts: error.maxAttempts,
                error,
              });
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
        } else if (!wasInteractiveShellLaunch) {
          const shellLaunch = resolveDefaultTerminalLaunchConfig();
          terminalLogger.info("terminal.tmux.session-missing.shell-rebuild", {
            message: "Tmux command session missing; rebuilding as shell",
            terminalSessionId: currentSession.id,
            sessionName: target.sessionName,
            socketPath: target.socketPath,
            previousCommand: currentSession.command,
            nextCommand: shellLaunch.command,
          });
          currentSession =
            (await options.terminalSessionManager.updateSessionLaunch(
              currentSession.id,
              shellLaunch,
            )) ?? currentSession;
          currentSession =
            (await options.terminalSessionManager.updateSessionMetadata(
              currentSession.id,
              {
                cwd: currentSession.cwd,
                activeCommand: null,
              },
            )) ?? currentSession;
          options.terminalSessionManager.markRunning(currentSession.id);
          warning = "Command exited; returned to a shell.";
        }

        if (wasInteractiveShellLaunch && !agentThreadToResume) {
          try {
            const attempt = options.tmuxService!.recordRebuildAttempt(
              currentSession.id,
            );
            warning = `Original tmux session was lost; created a fresh terminal session (${attempt.count}/${attempt.maxAttempts}).`;
            terminalLogger.warn("terminal.tmux.session-missing.rebuild", {
              message: "Tmux terminal session missing; rebuilding",
              terminalSessionId: currentSession.id,
              sessionName: target.sessionName,
              socketPath: target.socketPath,
              rebuildCount: attempt.count,
              rebuildWindowMs: attempt.windowMs,
            });
          } catch (error) {
            if (error instanceof TmuxRebuildLimitError) {
              terminalLogger.error("terminal.tmux.rebuild-limit.exceeded", {
                message: "Tmux rebuild limit exceeded",
                terminalSessionId: currentSession.id,
                count: error.count,
                windowMs: error.windowMs,
                maxAttempts: error.maxAttempts,
                error,
              });
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
      }

      if (!hasSession) {
        await options.tmuxService!.createDetachedSession(
          target,
          currentSession.cwd,
          {
            command: currentSession.command,
            args: currentSession.args,
            env: {
              RUNWEAVE_TERMINAL_SESSION_ID: currentSession.id,
              RUNWEAVE_PROJECT_ID: currentSession.projectId,
              RUNWEAVE_TMUX_SESSION_NAME: target.sessionName,
              RUNWEAVE_TOOLKIT_PLUGIN_ROOT:
                process.env.RUNWEAVE_TOOLKIT_PLUGIN_ROOT,
              RUNWEAVE_HOOK_ENDPOINT: process.env.RUNWEAVE_HOOK_ENDPOINT,
              RUNWEAVE_COMPLETION_HOOK_ENDPOINT:
                process.env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT,
              RUNWEAVE_HOOK_DEBUG_LOG: process.env.RUNWEAVE_HOOK_DEBUG_LOG,
              RUNWEAVE_HOOK_TOKEN: process.env.RUNWEAVE_HOOK_TOKEN,
              RUNWEAVE_BASE_URL: process.env.RUNWEAVE_BASE_URL,
              RUNWEAVE_BACKEND_PORT: process.env.RUNWEAVE_BACKEND_PORT,
              RUNWEAVE_CONFIG_FILE: process.env.RUNWEAVE_CONFIG_FILE,
              RUNWEAVE_DESKTOP_CHANNEL: process.env.RUNWEAVE_DESKTOP_CHANNEL,
            },
          },
        );
        if (
          isInteractiveShellLaunch(currentSession.command, currentSession.args)
        ) {
          await options.tmuxService!.waitForPaneReady(target);
        }
        if (agentThreadToResume) {
          await options.tmuxService!.sendInput(
            target,
            buildAgentResumeCommand(agentThreadToResume),
          );
        }
      }
      await options.tmuxOutputWatcher?.watchSession(currentSession);

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
          formatQuickExitMessage: ({
            args,
            command,
            exitCode,
            runDuration,
          }) => [
            `tmux attach client exited in ${runDuration} ms with exit code ${exitCode}`,
            `please check the tmux attach command and session state: ${JSON.stringify(
              { command, args },
              undefined,
              2,
            )}`,
          ],
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
    env: {
      RUNWEAVE_TERMINAL_SESSION_ID: options.session.id,
      RUNWEAVE_PROJECT_ID: options.session.projectId,
      RUNWEAVE_TOOLKIT_PLUGIN_ROOT:
        process.env.RUNWEAVE_TOOLKIT_PLUGIN_ROOT,
      RUNWEAVE_HOOK_ENDPOINT: process.env.RUNWEAVE_HOOK_ENDPOINT,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT:
        process.env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT,
      RUNWEAVE_HOOK_DEBUG_LOG: process.env.RUNWEAVE_HOOK_DEBUG_LOG,
      RUNWEAVE_HOOK_TOKEN: process.env.RUNWEAVE_HOOK_TOKEN,
      RUNWEAVE_BASE_URL: process.env.RUNWEAVE_BASE_URL,
      RUNWEAVE_BACKEND_PORT: process.env.RUNWEAVE_BACKEND_PORT,
      RUNWEAVE_CONFIG_FILE: process.env.RUNWEAVE_CONFIG_FILE,
      RUNWEAVE_DESKTOP_CHANNEL: process.env.RUNWEAVE_DESKTOP_CHANNEL,
    },
    fallback: resolveTerminalFallbackLaunchConfig({
      command: options.session.command,
      args: options.session.args,
    }),
    onFallbackActivated: (fallback) => {
      terminalLogger.warn("terminal.pty.fallback.activated", {
        message: "Terminal pty fallback activated",
        terminalSessionId: options.session.id,
        command: fallback.command,
        argsCount: fallback.args.length,
      });
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

export function buildAgentResumeCommand(thread: {
  provider: TerminalAgentKind;
  threadId: string;
}): string {
  const args = [
    ...(thread.provider === "codex" ? CODEX_SKIP_UPDATE_ON_STARTUP_ARGS : []),
    "resume",
    thread.threadId,
  ];
  return `${thread.provider} ${args.map(shellQuote).join(" ")}\n`;
}

export function resolveAgentThreadToResume(
  session: TerminalSessionRecord,
): { provider: TerminalAgentKind; threadId: string } | null {
  const activeProvider = getAgentForCommand(session.activeCommand);
  const currentThreadId = session.threadId?.trim();
  const currentProvider =
    session.threadProvider ?? (currentThreadId ? "codex" : undefined);
  const expectedProvider =
    activeProvider ?? currentProvider ?? session.lastThreadProvider;
  if (!expectedProvider) {
    return null;
  }

  if (currentThreadId && currentProvider === expectedProvider) {
    return { provider: expectedProvider, threadId: currentThreadId };
  }

  const recentThreadId = session.lastThreadId?.trim();
  return recentThreadId && session.lastThreadProvider === expectedProvider
    ? { provider: expectedProvider, threadId: recentThreadId }
    : null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createTmuxInputPacedRuntime(runtime: PtyRuntime): PtyRuntime {
  const queuedInput: string[] = [];
  let holdInputUntil = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let insideBracketedPaste = false;

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
    if (next === "\r" || next === "\n") {
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
      const splitResult = splitInputAtLineBreaks(data, insideBracketedPaste);
      insideBracketedPaste = splitResult.insideBracketedPaste;
      for (const chunk of splitResult.chunks) {
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

function splitInputAtLineBreaks(
  data: string,
  initialInsideBracketedPaste = false,
): { chunks: string[]; insideBracketedPaste: boolean } {
  const chunks: string[] = [];
  let insideBracketedPaste = initialInsideBracketedPaste;
  let start = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data.startsWith(BRACKETED_PASTE_START, index)) {
      insideBracketedPaste = true;
      index += BRACKETED_PASTE_START.length - 1;
      continue;
    }
    if (data.startsWith(BRACKETED_PASTE_END, index)) {
      insideBracketedPaste = false;
      index += BRACKETED_PASTE_END.length - 1;
      continue;
    }
    if (insideBracketedPaste) {
      continue;
    }
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
  return {
    chunks: chunks.length > 0 ? chunks : [data],
    insideBracketedPaste,
  };
}

export async function readTerminalScrollback(
  session: TerminalSessionRecord,
  terminalSessionManager: TerminalSessionManager,
  tmuxService: TmuxService | undefined,
  mode: "history" | "live",
): Promise<string> {
  return (
    await readTerminalScrollbackCapture(
      session,
      terminalSessionManager,
      tmuxService,
      mode,
    )
  ).data;
}

export interface TerminalScrollbackCapture {
  data: string;
  sourceCols?: number;
}

export async function readTerminalScrollbackCapture(
  session: TerminalSessionRecord,
  terminalSessionManager: TerminalSessionManager,
  tmuxService: TmuxService | undefined,
  mode: "history" | "live",
  tmuxHistoryLines?: number,
): Promise<TerminalScrollbackCapture> {
  if (isTmuxBackedSession(session) && tmuxService) {
    const readPersistedFallback = async () => ({
      data:
        mode === "history"
          ? await terminalSessionManager.readScrollback(session.id)
          : await terminalSessionManager.readLiveScrollback(session.id),
    });
    const target = resolveTmuxTarget(session, tmuxService);
    if (!(await tmuxService.hasSession(target).catch(() => false))) {
      return readPersistedFallback();
    }
    try {
      const captured =
        tmuxHistoryLines === undefined
          ? await tmuxService.capturePane(target)
          : await tmuxService.capturePane(target, tmuxHistoryLines);
      return {
        data: captured.data,
        sourceCols: captured.sourceCols,
      };
    } catch (error) {
      terminalLogger.error("terminal.tmux.capture-pane.failed", {
        message: "Tmux capture-pane failed",
        terminalSessionId: session.id,
        tmuxSessionName: session.tmuxSessionName,
        tmuxSocketPath: session.tmuxSocketPath,
        error,
      });
      return readPersistedFallback();
    }
  }

  if (mode === "history") {
    return { data: await terminalSessionManager.readScrollback(session.id) };
  }
  return { data: await terminalSessionManager.readLiveScrollback(session.id) };
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
