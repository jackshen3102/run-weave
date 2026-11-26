import { isDeepStrictEqual } from "node:util";
import {
  agyHookStatus,
  isNewerAgyContext,
  type AgyAgentContext,
} from "@runweave/shared/terminal/agy-agent";
import type { TerminalSessionManager } from "../manager/manager";
import type { TerminalPanelRecord, TerminalSessionRecord } from "../manager/records";

const queues = new WeakMap<TerminalSessionManager, Map<string, Promise<unknown>>>();

export async function withAgyHookQueue<T>(
  manager: TerminalSessionManager,
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  let pendingBySession = queues.get(manager);
  if (!pendingBySession) queues.set(manager, (pendingBySession = new Map()));
  const pending = (pendingBySession.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(action);
  pendingBySession.set(id, pending);
  try {
    return await pending;
  } finally {
    if (pendingBySession.get(id) === pending) pendingBySession.delete(id);
  }
}

/** Call after the existing Panel/provider/operation gates, inside the session queue. */
export async function recordAgyHookContext(
  manager: TerminalSessionManager,
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord | null,
  next: AgyAgentContext,
): Promise<
  | { accepted: true; status: "running" | "idle" | null; alreadyRunning: boolean }
  | { accepted: false; activityReplayAllowed: boolean }
> {
  const owner = panel ?? session;
  const previous = owner.agy;
  const status = agyHookStatus(next);
  // Only SessionStart or active work may acquire a new instance/conversation.
  // A subagent conversationId or delayed Stop from an unbound process is ignored.
  if (
    !isNewerAgyContext(next, previous) ||
    ((!previous || previous.instanceId !== next.instanceId) &&
      next.event !== "sessionstart" &&
      status !== "running")
  ) {
    return {
      accepted: false,
      activityReplayAllowed: isDeepStrictEqual(previous, next),
    };
  }
  const alreadyRunning = owner.terminalState?.state === "agent_running";
  owner.agy = next;
  if (panel) {
    await manager.upsertPanel(panel);
  } else {
    await manager.updateSessionThreadId(
      session.id,
      session.threadId ?? null,
      session.threadProvider ?? null,
      undefined,
      undefined,
      next,
    );
  }
  return { accepted: true, status, alreadyRunning };
}
