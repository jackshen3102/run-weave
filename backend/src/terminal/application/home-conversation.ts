import type { AppHomeConversationPreviewsResponse } from "@runweave/shared/terminal/session";
import { discoverAppServer } from "@runweave/config-node/app-server/discovery";
import { AppServerClient } from "../../app-server/client";
import { resolveReplyThread } from "../completion/reply-preview";
import type { TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";
import { readCodexContext } from "../runtime/codex-context";
import { getTerminalSessionAgent } from "../state/terminal-state-service";

function resolveHomeThread(manager: TerminalSessionManager, session: TerminalSessionRecord) {
  const panelId = manager.getPanelWorkspace(session.id)?.activePanelId;
  const panel = panelId ? manager.getPanel(panelId) : null;
  const owner = panel ?? session;
  if (getTerminalSessionAgent(owner) !== "codex") return resolveReplyThread(owner);
  if (panel) {
    const observed = readCodexContext(panel);
    if (observed.managed) {
      const context = observed.context;
      const generation = manager.getPanelAgentOperationGeneration(session.id, panel.id);
      return context?.primaryThreadId && !context.closed &&
        (!generation || generation.operationId === context.operationId)
        ? { id: context.primaryThreadId, provider: "codex" as const } : null;
    }
  }
  // Without a native observation, only an explicit binding identifies the current Codex thread.
  return owner.threadId ? resolveReplyThread(owner) : null;
}

export function homeConversation(manager: TerminalSessionManager, session: TerminalSessionRecord) {
  const panelId = manager.getPanelWorkspace(session.id)?.activePanelId;
  const owner = (panelId ? manager.getPanel(panelId) : null) ?? session;
  const identity = resolveHomeThread(manager, session);
  const key = identity ? `${identity.provider}:${identity.id}:${panelId ?? ""}` : null;
  const reply = owner.latestReply;
  return {
    identity, key,
    subtitle: identity && reply?.threadId === identity.id && reply.provider === identity.provider
      ? reply.text || session.cwd : session.cwd,
  };
}

/** Reads only the App Server's bounded in-memory projection, never a thread detail. */
export async function readHomeConversationPreviews(
  manager: TerminalSessionManager, ids: string[],
): Promise<AppHomeConversationPreviewsResponse> {
  const targets = ids.flatMap((id) => {
    const session = manager.getSession(id);
    const target = session ? homeConversation(manager, session) : null;
    return target?.identity ? [{ session: session!, ...target }] : [];
  });
  if (!targets.length) return { sessions: [] };
  const connection = await discoverAppServer();
  const result = connection ? await new AppServerClient(connection).getThreadPreviews(
    [...new Set(targets.map((target) => target.identity!.id))], AbortSignal.timeout(1500),
  ) : null;
  return { sessions: targets.flatMap((target) => {
    const current = manager.getSession(target.session.id);
    if (!current || homeConversation(manager, current).key !== target.key) return [];
    const preview = result?.previews.find((value) => value.threadId === target.identity!.id &&
      value.provider === target.identity!.provider) ?? {
      threadId: target.identity!.id, provider: target.identity!.provider, available: false,
      availability: result ? "source_missing" as const : "read_failed" as const,
      turnId: null, userText: null, agentText: null,
    };
    return [{ terminalSessionId: current.id, conversationKey: target.key!, conversationPreview: preview }];
  }) };
}
