import type { AppHomeConversationPreviewsResponse } from "@runweave/shared/terminal/session";
import { discoverAppServer } from "@runweave/config-node/app-server/discovery";
import { AppServerClient } from "../../app-server/client";
import { resolveReplyThread } from "../completion/reply-preview";
import type { TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";

export function homeConversation(manager: TerminalSessionManager, session: TerminalSessionRecord) {
  const panelId = manager.getPanelWorkspace(session.id)?.activePanelId;
  const owner = (panelId ? manager.getPanel(panelId) : null) ?? session;
  const identity = resolveReplyThread(owner);
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
  if (!connection) return { sessions: [] };
  const result = await new AppServerClient(connection).getThreadPreviews(
    [...new Set(targets.map((target) => target.identity!.id))], AbortSignal.timeout(1500),
  );
  if (!result) return { sessions: [] };
  return { sessions: targets.flatMap((target) => {
    const current = manager.getSession(target.session.id);
    if (!current || homeConversation(manager, current).key !== target.key) return [];
    const preview = result.previews.find((value) => value.threadId === target.identity!.id &&
      value.provider === target.identity!.provider);
    return preview ? [{ terminalSessionId: current.id, conversationKey: target.key!, conversationPreview: preview }] : [];
  }) };
}
