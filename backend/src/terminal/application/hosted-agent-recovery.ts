import { randomUUID } from "node:crypto";
import type { RecoverTerminalAgentRequest, RecoverTerminalAgentResponse } from "@runweave/shared/terminal/agent-preparation";
import type { TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";
import { recoverHostedTerminal } from "../runtime/pty-host-runtime";
import { getPtyHost } from "../runtime/pty-host-client";
import { resolveHostedAgentRecovery } from "../runtime/recovery-policy";
import { resolveEffectiveTerminalState } from "./terminal-state-projection";
import { TerminalPanelError, type TerminalPanelOptions } from "./panel-common";

export async function recoverHostedAgent(
  manager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: TerminalPanelOptions,
  request: RecoverTerminalAgentRequest,
): Promise<RecoverTerminalAgentResponse> {
  if (!options.runtimeRegistry || request.panelId && request.panelId !== "default")
    throw new TerminalPanelError(409, "Hosted terminal recovery unavailable for this target");
  if (!(await getPtyHost()).supportsSessionReplacement)
    throw new TerminalPanelError(409, "Update the running PTY Host before recovering an agent");
  const resolve = () => resolveHostedAgentRecovery(session,
    resolveEffectiveTerminalState(manager, options.terminalStateService, session));
  const target = resolve();
  if (!target) throw new TerminalPanelError(409, "Only an idle hosted terminal with a saved agent thread can be recovered");
  const operationId = `terminal_agent_recover_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  try {
    await recoverHostedTerminal({ session, terminalSessionManager: manager,
      runtimeRegistry: options.runtimeRegistry, terminalStateService: options.terminalStateService }, phase => {
      // Closing the old Agent can legitimately publish shell_idle. Recheck the
      // saved identity after close, not its pre-close foreground state.
      const current = phase === "before-close" ? resolve() : {
        provider: session.threadId ? session.threadProvider ?? "codex" : session.lastThreadProvider,
        threadId: session.threadId?.trim() || session.lastThreadId?.trim(),
      };
      if (manager.getSession(session.id) !== session || session.status !== "running" || !current || current.provider !== target.provider ||
          current.threadId !== target.threadId || request.expectedThreadId && request.expectedThreadId !== current.threadId)
        throw new Error("Terminal recovery target changed; refresh before retrying");
      return target;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Hosted terminal recovery failed";
    const retry = resolve();
    const guidance = retry?.provider === target.provider && retry.threadId === target.threadId
      ? "Saved conversation preserved; you can retry Recover agent."
      : "Check the terminal before retrying; the recovery command may already have been submitted.";
    throw new TerminalPanelError(409, `${detail}. ${guidance}`);
  }
  return { operationId, terminalSessionId: session.id, panelId: "default", tmuxPaneId: null,
    provider: target.provider, threadId: null, status: "starting", phase: "command_submitted",
    createdPanel: false, startedAt, commandSubmittedAt: new Date().toISOString(),
    resumedThreadId: target.threadId, recoveryMode: "pty_respawn" };
}
