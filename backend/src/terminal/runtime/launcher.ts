import { isInteractiveShellLaunch as isShellLaunch } from "@runweave/shared/terminal/shell";
import { usesPtyHost } from "./pty-host-client";
import { ensureHostedTerminal } from "./pty-host-runtime";
import { createTmuxInputPacedRuntime } from "./tmux-input-runtime";
import { buildAgentResumeCommand, getAgentAdapter } from "./agent-adapters";
export { buildAgentResumeCommand } from "./agent-adapters";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import { logger } from "../../logging/index";
import {
  resolveDefaultTerminalLaunchConfig,
  resolveTerminalFallbackLaunchConfig,
} from "./default-shell";
import type { PtyRuntime, PtyService } from "./pty-service";
import type { TerminalRuntimeRegistry } from "./registry";
import { createTerminalRuntimeRecorder } from "./recorder";
import type { TmuxService, TmuxTarget } from "../tmux/service";
import type { TmuxOutputWatcher } from "../tmux/output-watcher";
import { TmuxRebuildLimitError } from "../tmux/service";
import { resolveAgentThreadToResume } from "./recovery-policy";
export { resolveAgentThreadToResume } from "./recovery-policy";
import {
  buildTerminalRuntimeEnvironment,
  buildTmuxSessionRuntimeEnvironment,
} from "./environment";

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
  /** Stable per-viewer identity for tmux display output; omitted for control-plane input. */
  displayRuntimeId?: string;
}

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
  const result = await ensureTerminalRuntimeInternal(options, true);
  if (!result) throw new Error("Terminal runtime was not attached");
  return result;
}

/** Start the task owner and recorder without allocating an unused tmux display. */
export async function ensureTerminalStarted(
  options: EnsureTerminalRuntimeOptions,
): Promise<void> {
  await ensureTerminalRuntimeInternal(options, false);
}

async function ensureTerminalRuntimeInternal(
  options: EnsureTerminalRuntimeOptions,
  attach: boolean,
): Promise<EnsureTerminalRuntimeResult | undefined> {
  const runtimeId = isTmuxBackedSession(options.session)
    ? options.displayRuntimeId ?? options.session.id
    : options.session.id;
  const findRuntime = () => options.displayRuntimeId
    ? options.runtimeRegistry.getRuntime(runtimeId)
    : options.runtimeRegistry.getSessionRuntime(options.session.id);
  const existingRuntime = findRuntime();
  if (existingRuntime) {
    await existingRuntime.ready;
    return { runtime: existingRuntime };
  }

  if (isTmuxBackedSession(options.session) && options.tmuxService) {
    return options.tmuxService.withSessionLock(options.session.id, async () => {
      const existingLockedRuntime = findRuntime();
      if (existingLockedRuntime) {
        await existingLockedRuntime.ready;
        return { runtime: existingLockedRuntime };
      }

      let currentSession =
        options.terminalSessionManager.getSession(options.session.id) ??
        options.session;
      let target = resolveTmuxTarget(currentSession, options.tmuxService!);
      await options.tmuxService!.sanitizeGlobalEnvironment(target);
      let hasSession = await options.tmuxService!.hasSession(target);
      if (
        !hasSession &&
        target.socketPath !== options.tmuxService!.socketPath
      ) {
        const previousSocketPath = target.socketPath;
        target = {
          sessionName: target.sessionName,
          socketPath: options.tmuxService!.socketPath,
        };
        await options.tmuxService!.sanitizeGlobalEnvironment(target);
        hasSession = await options.tmuxService!.hasSession(target);
        currentSession =
          (await options.terminalSessionManager.updateRuntimeMetadata(
            currentSession.id,
            {
              runtimeKind: "tmux",
              tmuxSessionName: target.sessionName,
              tmuxSocketPath: target.socketPath,
              recoverable: true,
            },
          )) ?? currentSession;
        terminalLogger.info("terminal.tmux.socket.migrated", {
          message: "Migrated missing tmux session to the current socket",
          terminalSessionId: currentSession.id,
          sessionName: target.sessionName,
          previousSocketPath,
          socketPath: target.socketPath,
          sessionAlreadyPresent: hasSession,
        });
      }
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
            terminalLogger.warn("terminal.tmux.session-missing.agent-resume", {
              message: "Tmux terminal session missing; resuming agent thread",
              terminalSessionId: currentSession.id,
              provider: agentThreadToResume.provider,
              threadId: agentThreadToResume.threadId,
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
        const terminalEnvironment = buildTerminalRuntimeEnvironment({
          terminalSessionId: currentSession.id,
          projectId: currentSession.projectId,
          source: currentSession.source,
          tmuxSessionName: target.sessionName,
        });
        const actualLaunch = await options.tmuxService!.createDetachedSession(
          target,
          currentSession.cwd,
          {
            command: currentSession.command,
            args: currentSession.args,
            env: terminalEnvironment,
          },
        );
        if (actualLaunch.fallbackReason) {
          currentSession = (await options.terminalSessionManager.updateSessionLaunch(currentSession.id, actualLaunch)) ?? currentSession;
          warning = actualLaunch.fallbackReason;
        }
        if (
          isInteractiveShellLaunch(currentSession.command, currentSession.args)
        ) {
          await options.tmuxService!.waitForPaneReady(target);
        }
        if (agentThreadToResume) {
          await options.tmuxService!.sendInput(
            target,
            buildAgentResumeCommand({
              ...agentThreadToResume,
              executable: agentThreadToResume.provider === "codex"
                ? terminalEnvironment.RUNWEAVE_CODEX_BINARY
                : undefined,
              sessionFile: await getAgentAdapter(
                agentThreadToResume.provider,
              ).resolveResumeTarget(
                agentThreadToResume.threadId,
                currentSession.pi,
              ),
            }),
          );
          currentSession =
            (await options.terminalSessionManager.updateSessionThreadId(
              currentSession.id,
              agentThreadToResume.threadId,
              agentThreadToResume.provider,
            )) ?? currentSession;
        }
      }
      await options.tmuxService!.syncSessionEnvironment(
        target,
        buildTmuxSessionRuntimeEnvironment({
          terminalSessionId: currentSession.id,
          projectId: currentSession.projectId,
          source: currentSession.source,
          tmuxSessionName: target.sessionName,
        }),
      );
      await options.tmuxOutputWatcher?.watchSession(currentSession);

      // The tmux pane owns the task. Creating a terminal does not need a PTY
      // attach, replay buffer or screen mirror before a viewer/input needs one.
      if (!attach) return;

      const attachCommand = options.tmuxService!.buildAttachCommand(
        target,
        currentSession.cwd,
        undefined,
        { ignoreSize: !options.displayRuntimeId },
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
      options.runtimeRegistry.createRuntime(currentSession.id, runtime, {
        recoverableOutput: true,
        runtimeId,
      });
      try {
        // tmux emits its initial redraw after configuring the attach PTY. Until
        // then its line discipline can echo, buffer or discard a burst of input.
        await runtime.ready;
      } catch (error) {
        await options.runtimeRegistry.disposeRuntime(runtimeId);
        throw error;
      }
      if (!options.displayRuntimeId)
        options.runtimeRegistry.retainIdleRuntime(runtimeId);
      return {
        runtime: options.runtimeRegistry.getRuntime(runtimeId)!,
        warning,
      };
    });
  }

  if (options.session.ptyHost || usesPtyHost()) return ensureHostedTerminal(options);

  const runtime = options.ptyService.spawnSession({
    command: options.session.command,
    args: options.session.args,
    cwd: options.session.cwd,
    env: buildTerminalRuntimeEnvironment({
      terminalSessionId: options.session.id,
      projectId: options.session.projectId,
      source: options.session.source,
    }),
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
  return isShellLaunch({ command, args });
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
