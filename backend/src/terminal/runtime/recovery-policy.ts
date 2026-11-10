import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import type { TerminalSessionRecord } from "../manager/manager";
import { getAgentForCommand } from "../state/terminal-state-service";

export const RebuildWindowMs = 60_000;
export const MaxRebuildAttempts = 3;

export class TerminalRebuildLimitError extends Error {
  constructor(
    readonly terminalSessionId: string,
    readonly count: number,
    readonly windowMs: number,
    readonly maxAttempts: number,
    runtime = "terminal",
  ) {
    super(`${runtime} session rebuild exceeded ${maxAttempts} attempts in ${windowMs} ms for ${terminalSessionId}`);
    this.name = "TerminalRebuildLimitError";
  }
}

export function recordTerminalRebuildAttempt(
  history: Map<string, number[]>,
  terminalSessionId: string,
  now = Date.now(),
): { allowed: true; count: number; windowMs: number; maxAttempts: number } {
  const attempts = (history.get(terminalSessionId) ?? []).filter(timestamp => timestamp >= now - RebuildWindowMs);
  history.set(terminalSessionId, attempts);
  if (attempts.length >= MaxRebuildAttempts)
    throw new TerminalRebuildLimitError(terminalSessionId, attempts.length + 1, RebuildWindowMs, MaxRebuildAttempts);
  attempts.push(now);
  return { allowed: true, count: attempts.length, windowMs: RebuildWindowMs, maxAttempts: MaxRebuildAttempts };
}

export function resolveAgentThreadToResume(
  session: TerminalSessionRecord,
): { provider: TerminalAgentKind; threadId: string } | null {
  // Windows shells do not all publish foreground-command markers. A persisted
  // lifecycle hook can still identify the active Agent, but a shell-idle state cannot.
  const activeProvider = getAgentForCommand(session.activeCommand) ??
    (session.terminalState?.state.startsWith("agent_") ? session.terminalState.agent : null);
  // Claude command identity alone does not prove a recoverable pane generation.
  // Keep automatic relaunch disabled until its launch/settled contract is verified.
  if (!activeProvider || activeProvider === "claude") return null;
  const currentThreadId = session.threadId?.trim();
  const currentProvider = session.threadProvider ?? (currentThreadId ? "codex" : undefined);
  if (currentThreadId && currentProvider === activeProvider)
    return { provider: activeProvider, threadId: currentThreadId };
  const recentThreadId = session.lastThreadId?.trim();
  return recentThreadId && session.lastThreadProvider === activeProvider
    ? { provider: activeProvider, threadId: recentThreadId }
    : null;
}
