import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import { logger } from "../../logging/index";
import { codexAppServerClient } from "../../voice/codex-app-server-client";
import { AppServerHistoryGateway } from "../../work-history/app-server-history-gateway";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import { getTerminalSessionAgent } from "../state/terminal-state-service";

type ReplyOwner = TerminalSessionRecord | TerminalPanelRecord;
type ThreadIdentity = { id: string; provider: TerminalAgentKind };
const pendingReads = new WeakMap<ReplyOwner, Promise<void>>();

export function resolveReplyThread(owner: ReplyOwner): ThreadIdentity | null {
  const agent = getTerminalSessionAgent(owner);
  if (!agent) return null;
  if (owner.threadId) {
    const provider = owner.threadProvider ?? "codex";
    return provider === agent ? { id: owner.threadId, provider } : null;
  }
  return owner.lastThreadId && owner.lastThreadProvider === agent
    ? { id: owner.lastThreadId, provider: agent }
    : null;
}

export function formatReplyPreview(
  reply: string | null | undefined,
): string | null {
  if (!reply) return null;
  const text = reply
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^\n]*?\)/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)([^\n]+?)\1/g, "$2")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|[.,!?，。！？]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const characters: string[] = [];
  for (const part of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text)) {
    if (characters.length === 120) return `${characters.join("")}…`;
    characters.push(part.segment);
  }
  return text;
}

interface CodexReplyThread {
  thread?: {
    id?: string;
    turns?: Array<{
      status?: string;
      items?: Array<{
        type?: string;
        role?: string;
        phase?: string;
        text?: string;
      }>;
    }>;
  };
}

function latestCodexReply(response: CodexReplyThread): string | null {
  for (const turn of [...(response.thread?.turns ?? [])].reverse()) {
    if (turn.status !== "completed") continue;
    for (const item of [...(turn.items ?? [])].reverse()) {
      if (
        (item.type === "agentMessage" || item.role === "assistant") &&
        (!item.phase || item.phase === "final_answer") &&
        item.text?.trim()
      ) {
        return item.text.trim();
      }
    }
  }
  return null;
}

async function readCompletedReply(
  identity: ThreadIdentity,
): Promise<string | null> {
  if (identity.provider === "codex") {
    const response = (await codexAppServerClient.sendRequest("thread/read", {
      threadId: identity.id,
      includeTurns: true,
    })) as CodexReplyThread;
    if (!response?.thread || response.thread.id !== identity.id)
      throw new Error("Thread reply unavailable");
    return latestCodexReply(response);
  }
  const response = await new AppServerHistoryGateway().getThreadDetail(
    identity.id,
  );
  if (
    response.availability !== "available" ||
    !response.detail ||
    !("lifecycle" in response.detail) ||
    response.detail.id !== identity.id ||
    response.detail.provider !== identity.provider
  ) {
    throw new Error("Thread reply unavailable");
  }
  return (
    [...response.detail.turns]
      .reverse()
      .find((turn) => turn.status === "completed" && turn.preview?.trim())
      ?.preview ?? null
  );
}

async function backfillReply(
  manager: TerminalSessionManager,
  session: TerminalSessionRecord,
  owner: ReplyOwner,
  identity: ThreadIdentity,
): Promise<void> {
  const previous = owner.latestReply;
  const revision = previous?.completionRevision ?? session.completionRevision;
  try {
    const text = formatReplyPreview(await readCompletedReply(identity));
    const current = resolveReplyThread(owner);
    if (
      current?.id !== identity.id ||
      current.provider !== identity.provider ||
      owner.latestReply !== previous
    )
      return;
    await manager.updateLatestReply(
      session.id,
      "terminalSessionId" in owner ? owner.id : null,
      {
        threadId: identity.id,
        provider: identity.provider,
        text:
          text ??
          (previous?.threadId === identity.id &&
          previous.provider === identity.provider
            ? previous.text
            : null),
        completionRevision: revision,
      },
    );
  } catch (error) {
    logger.warn("terminal.reply-backfill.failed", {
      component: "terminal-reply",
      terminalSessionId: session.id,
      threadId: identity.id,
      error,
    });
  }
}

export async function buildTerminalReplySubtitle(
  manager: TerminalSessionManager,
  session: TerminalSessionRecord,
): Promise<string> {
  // Retry once if the user switches thread/panel while history is being read.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const activePanelId = manager.getPanelWorkspace(session.id)?.activePanelId;
    const owner =
      (activePanelId ? manager.getPanel(activePanelId) : null) ?? session;
    const identity = resolveReplyThread(owner);
    if (!identity) return session.cwd;
    const cached = owner.latestReply;
    if (
      !cached ||
      cached.threadId !== identity.id ||
      cached.provider !== identity.provider ||
      cached.needsRefresh
    ) {
      let pending = pendingReads.get(owner);
      if (!pending) {
        pending = backfillReply(manager, session, owner, identity).finally(() =>
          pendingReads.delete(owner),
        );
        pendingReads.set(owner, pending);
      }
      await pending;
    }
    const current = resolveReplyThread(owner);
    if (
      manager.getPanelWorkspace(session.id)?.activePanelId !== activePanelId ||
      current?.id !== identity.id ||
      current.provider !== identity.provider
    )
      continue;
    const reply = owner.latestReply;
    return reply &&
      reply.threadId === current.id &&
      reply.provider === current.provider
      ? reply.text || session.cwd
      : session.cwd;
  }
  return session.cwd;
}
