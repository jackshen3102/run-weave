import { isDeepStrictEqual } from "node:util";
import { claudeHookStatus, isNewerClaudeContext, type ClaudeAgentContext } from "@runweave/shared/terminal/claude-agent";
import type { TerminalSessionManager } from "../manager/manager";
import type { TerminalPanelRecord, TerminalSessionRecord } from "../manager/records";

// Direct HTTP and App Server can deliver the same event concurrently.
const queues = new WeakMap<TerminalSessionManager, Map<string, Promise<unknown>>>();
export async function withClaudeHookQueue<T>(manager: TerminalSessionManager, id: string, action: () => Promise<T>): Promise<T> {
  let pendingBySession = queues.get(manager);
  if (!pendingBySession) queues.set(manager, pendingBySession = new Map());
  const pending = (pendingBySession.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
  pendingBySession.set(id, pending);
  try { return await pending; }
  finally { if (pendingBySession.get(id) === pending) pendingBySession.delete(id); }
}

/** Call after the existing Panel/provider/operation gates, inside the session queue. */
export async function recordClaudeHookContext(
  manager: TerminalSessionManager, session: TerminalSessionRecord,
  panel: TerminalPanelRecord | null, next: ClaudeAgentContext,
): Promise<{ accepted: true; status: "running" | "idle" | null } | { accepted: false; activityReplayAllowed: boolean }> {
  const owner = panel ?? session;
  const previous = owner.claude;
  const status = claudeHookStatus(next);
  // Only startup or evidence of work can acquire a generation. A delayed idle
  // or Stop from an unbound process must never acquire the current panel.
  if (!isNewerClaudeContext(next, previous) ||
      ((!previous || previous.instanceId !== next.instanceId) &&
        next.event !== "sessionstart" && status !== "running")) {
    return { accepted: false, activityReplayAllowed: isDeepStrictEqual(previous, next) };
  }
  owner.claude = next;
  if (panel) await manager.upsertPanel(panel);
  else await manager.updateSessionThreadId(session.id,
    session.threadId ?? null, session.threadProvider ?? null, undefined, next);
  return { accepted: true, status };
}
