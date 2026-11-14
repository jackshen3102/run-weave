import type { TerminalSessionManager } from "../manager/manager";
import { killTmuxSessionForTerminal } from "../runtime/launcher";
import type { TerminalRuntimeRegistry } from "../runtime/registry";
import type { TmuxOutputWatcher } from "../tmux/output-watcher";
import type { TmuxService } from "../tmux/service";

interface TerminalSessionDeletionOptions {
  terminalSessionManager: TerminalSessionManager;
  runtimeRegistry?: TerminalRuntimeRegistry;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  tmuxService?: TmuxService;
}

export async function deleteTerminalSession(
  terminalSessionId: string,
  options: TerminalSessionDeletionOptions,
): Promise<boolean> {
  const dispose = async () => {
    const session = options.terminalSessionManager.getSession(terminalSessionId);
    await options.runtimeRegistry?.disposeSessionRuntimes(terminalSessionId);
    await options.tmuxOutputWatcher?.unwatchSession(terminalSessionId);
    if (session) await killTmuxSessionForTerminal(session, options.tmuxService);
    return options.terminalSessionManager.destroySession(terminalSessionId);
  };
  // Attach/recovery must finish before disposal; queued attaches then observe
  // the deleted record instead of rebuilding a task from an old reference.
  return options.tmuxService
    ? options.tmuxService.withSessionLock(terminalSessionId, dispose)
    : dispose();
}
