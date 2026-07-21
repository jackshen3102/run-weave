import type { TerminalSessionManager } from "./manager";
import { buildTmuxSessionRuntimeEnvironment } from "./runtime-environment";
import {
  isTmuxBackedSession,
  resolveTmuxTarget,
} from "./runtime-launcher";
import { isProcessExitCode } from "./tmux-internals";
import type { TmuxService, TmuxTarget } from "./tmux-service";

const TMUX_ENVIRONMENT_SYNC_SOCKET_CONCURRENCY = 2;

export async function syncExistingTmuxSessionEnvironments(
  terminalSessionManager: TerminalSessionManager,
  tmuxService: TmuxService,
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  Array<{ terminalSessionId: string; socketPath: string; error: unknown }>
> {
  const sessionsBySocket = new Map<
    string,
    Array<{
      terminalSessionId: string;
      projectId: string;
      target: TmuxTarget;
    }>
  >();
  const sessions = terminalSessionManager
    .listSessions()
    .filter(
      (session) => session.status === "running" && isTmuxBackedSession(session),
    )
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  for (const session of sessions) {
    const target = resolveTmuxTarget(session, tmuxService);
    const socketSessions = sessionsBySocket.get(target.socketPath) ?? [];
    socketSessions.push({
      terminalSessionId: session.id,
      projectId: session.projectId,
      target,
    });
    sessionsBySocket.set(target.socketPath, socketSessions);
  }

  const socketEntries = Array.from(sessionsBySocket.entries());
  const failures: Array<{
    terminalSessionId: string;
    socketPath: string;
    error: unknown;
  }> = [];
  for (
    let index = 0;
    index < socketEntries.length;
    index += TMUX_ENVIRONMENT_SYNC_SOCKET_CONCURRENCY
  ) {
    const batchFailures = await Promise.all(
      socketEntries
        .slice(index, index + TMUX_ENVIRONMENT_SYNC_SOCKET_CONCURRENCY)
        .map(async ([socketPath, socketSessions]) => {
          const firstSession = socketSessions[0];
          if (!firstSession) {
            return null;
          }
          try {
            await tmuxService.sanitizeGlobalEnvironment(firstSession.target);
            const liveSessionNames = new Set(
              (await tmuxService.listSessions(socketPath)).map(
                (session) => session.sessionName,
              ),
            );
            for (const session of socketSessions) {
              if (!liveSessionNames.has(session.target.sessionName)) {
                continue;
              }
              try {
                await tmuxService.syncSessionEnvironment(
                  session.target,
                  buildTmuxSessionRuntimeEnvironment(
                    {
                      terminalSessionId: session.terminalSessionId,
                      projectId: session.projectId,
                      tmuxSessionName: session.target.sessionName,
                    },
                    env,
                  ),
                );
              } catch (error) {
                if (isProcessExitCode(error, 1)) {
                  continue;
                }
                return {
                  terminalSessionId: session.terminalSessionId,
                  socketPath,
                  error,
                };
              }
            }
            return null;
          } catch (error) {
            return {
              terminalSessionId: firstSession.terminalSessionId,
              socketPath,
              error,
            };
          }
        }),
    );
    failures.push(
      ...batchFailures.filter((failure) => failure !== null),
    );
  }
  return failures;
}
