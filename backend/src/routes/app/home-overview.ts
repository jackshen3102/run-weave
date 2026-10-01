import type { AppHomeOverviewResponse, AppHomeOverviewSession } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import { Router } from "express";
import { z } from "zod";
import { HomeBranchStatusService } from "../../terminal/git/home-branch-status";
import path from "node:path";
import { logger } from "../../logging/index";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import {
  readCodexThreadSnapshot,
  type CodexThreadStatusType,
} from "../../terminal/runtime/codex-thread-snapshot";
import {
  getTerminalSessionAgent,
  type TerminalStateService,
} from "../../terminal/state/terminal-state-service";
import {
  toProjectPayload,
  toSessionListItem,
} from "../../terminal/application/payloads";
import { resolveEffectiveTerminalState } from "../../terminal/application/terminal-state-projection";
import { homeConversation, readHomeConversationPreviews } from "../../terminal/application/home-conversation";

type TerminalSession = ReturnType<
  TerminalSessionManager["listSessions"]
>[number];
type DisplayStatusPayload = Pick<
  AppHomeOverviewSession,
  "displayStatus" | "displayStatusLabel" | "terminalState"
>;
type CodexThreadOverviewSnapshot = {
  preview: string | null;
  statusType: CodexThreadStatusType | null;
};

function resolveThreadIdentity(
  session: TerminalSession,
): { provider: NonNullable<TerminalSession["threadProvider"]>; id: string } | null {
  const activeAgent = getTerminalSessionAgent(session);
  if (session.threadId) {
    const provider = session.threadProvider ?? "codex";
    return provider === activeAgent ? { provider, id: session.threadId } : null;
  }
  if (
    session.lastThreadId &&
    session.lastThreadProvider &&
    session.lastThreadProvider === activeAgent
  ) {
    return {
      provider: session.lastThreadProvider,
      id: session.lastThreadId,
    };
  }
  return null;
}

const appHomeLogger = logger.child({ component: "app-home-overview" });

function basename(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, "");
  return path.basename(normalized) || normalized || value;
}

function buildSessionTitle(session: TerminalSession): string {
  const alias = session.alias?.trim();
  if (alias) {
    return alias;
  }

  const agent = getTerminalSessionAgent(session);
  const commandLabel =
    agent ?? session.activeCommand?.trim() ?? basename(session.command);
  const directoryLabel = basename(session.cwd);
  return directoryLabel ? `${commandLabel} · ${directoryLabel}` : commandLabel;
}

function resolveEffectivePreview(
  session: TerminalSession,
  codexThreadSnapshot?: CodexThreadOverviewSnapshot | null,
): string | undefined {
  if (codexThreadSnapshot) {
    return codexThreadSnapshot.preview ?? undefined;
  }

  if (!resolveThreadIdentity(session)) {
    return undefined;
  }

  return session.preview?.trim() || undefined;
}

function resolveEffectiveThreadId(
  session: TerminalSession,
): string | undefined {
  return resolveThreadIdentity(session)?.id;
}

function buildDisplayStatus(
  session: TerminalSession,
  terminalState: TerminalState,
  codexThreadSnapshot?: CodexThreadOverviewSnapshot | null,
): DisplayStatusPayload {
  if (session.status === "exited") {
    return {
      displayStatus: "exited",
      displayStatusLabel: "Exited",
      terminalState,
    };
  }

  const codexDisplayStatus = buildCodexDisplayStatus(
    session,
    codexThreadSnapshot,
  );
  if (codexDisplayStatus) {
    return codexDisplayStatus;
  }

  if (terminalState.state === "agent_running") {
    return {
      displayStatus: "running",
      displayStatusLabel: "Agent Running",
      terminalState,
    };
  }

  if (terminalState.state === "agent_starting") {
    return {
      displayStatus: "agent-starting",
      displayStatusLabel: "Agent Starting",
      terminalState,
    };
  }

  if (terminalState.state === "agent_idle") {
    return {
      displayStatus: "agent-idle",
      displayStatusLabel: "Agent Idle",
      terminalState,
    };
  }

  return { displayStatus: "idle", displayStatusLabel: "Idle", terminalState };
}

function buildCodexDisplayStatus(
  session: TerminalSession,
  codexThreadSnapshot?: CodexThreadOverviewSnapshot | null,
): DisplayStatusPayload | null {
  if (
    !resolveThreadIdentity(session) ||
    !codexThreadSnapshot?.statusType
  ) {
    return null;
  }

  if (codexThreadSnapshot.statusType === "notLoaded") {
    return null;
  }

  if (codexThreadSnapshot.statusType === "systemError") {
    appHomeLogger.warn("app.home-overview.codex-thread-status.system-error", {
      message: "Codex thread reported systemError status",
      terminalSessionId: session.id,
      threadId: session.threadId ?? null,
    });
    return null;
  }

  const agent = resolveThreadIdentity(session)?.provider ?? "codex";
  const terminalState: TerminalState =
    codexThreadSnapshot.statusType === "active"
      ? { state: "agent_running", agent }
      : { state: "agent_idle", agent };

  return terminalState.state === "agent_running"
    ? {
        displayStatus: "running",
        displayStatusLabel: "Agent Running",
        terminalState,
      }
    : {
        displayStatus: "agent-idle",
        displayStatusLabel: "Agent Idle",
        terminalState,
      };
}

async function readCodexThreadOverviewSnapshot(
  session: TerminalSession,
): Promise<CodexThreadOverviewSnapshot | null> {
  if (
    session.status === "exited" ||
    resolveThreadIdentity(session)?.provider !== "codex"
  ) {
    return null;
  }

  try {
    return await readCodexThreadSnapshot(resolveThreadIdentity(session)!.id);
  } catch (error) {
    appHomeLogger.warn("app.home-overview.codex-thread.read-failed", {
      message: "Failed to read Codex thread while building app home overview",
      terminalSessionId: session.id,
      threadId: resolveThreadIdentity(session)?.id ?? null,
      error,
    });
    return null;
  }
}

async function readAgentThreadOverviewSnapshot(
  session: TerminalSession,
): Promise<CodexThreadOverviewSnapshot | null> {
  const identity = resolveThreadIdentity(session);
  if (!identity) {
    return null;
  }
  if (identity.provider === "codex") {
    return readCodexThreadOverviewSnapshot(session);
  }
  if (
    session.status === "exited" ||
    getTerminalSessionAgent(session) !== identity.provider
  ) {
    return null;
  }
  // Hook/runtime state already owns provider liveness. Reading Pi/Trae detail here
  // would parse full histories on the critical path of every homepage request.
  return null;
}

async function updateSessionPreviewFromCodexThread(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSession,
  codexThreadSnapshot: CodexThreadOverviewSnapshot | null,
): Promise<void> {
  if (!codexThreadSnapshot) {
    return;
  }

  const preview = codexThreadSnapshot.preview;
  if ((session.preview ?? null) === preview) {
    return;
  }

  try {
    await terminalSessionManager.updateSessionPreview(session.id, preview);
  } catch (error) {
    appHomeLogger.warn("app.home-overview.codex-thread-preview.update-failed", {
      message:
        "Failed to update Codex thread preview while building app home overview",
      terminalSessionId: session.id,
      threadId: session.threadId ?? null,
      error,
    });
  }
}

export async function buildAppHomeOverviewPayload(
  terminalSessionManager: TerminalSessionManager,
  terminalStateService: TerminalStateService,
): Promise<AppHomeOverviewResponse> {
  const sessions = await Promise.all(
    terminalSessionManager.listSessions().map(async (session) => {
      const codexThreadSnapshot =
        await readAgentThreadOverviewSnapshot(session);
      await updateSessionPreviewFromCodexThread(
        terminalSessionManager,
        session,
        codexThreadSnapshot,
      );

      const conversation = homeConversation(terminalSessionManager, session);
      return {
        ...toSessionListItem(session),
        threadId: resolveEffectiveThreadId(session),
        preview: resolveEffectivePreview(session, codexThreadSnapshot),
        title: buildSessionTitle(session),
        subtitle: conversation.subtitle,
        conversationKey: conversation.key,
        ...buildDisplayStatus(
          session,
          resolveEffectiveTerminalState(
            terminalSessionManager,
            terminalStateService,
            session,
          ),
          codexThreadSnapshot,
        ),
      };
    }),
  );

  return {
    projects: terminalSessionManager
      .listProjects()
      .map((project) => toProjectPayload(project)),
    sessions,
  };
}

export function createAppHomeOverviewRouter(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
}) {
  const router = Router();
  const branchStatus = new HomeBranchStatusService();
  const branchRequest = z.object({
    terminalSessionIds: z.array(z.string().min(1).max(200)).max(100),
    refresh: z.boolean().optional(),
  }).strict();

  router.post("/home/conversation-previews", async (req, res) => {
    const parsed = z.object({ terminalSessionIds: z.array(z.string().min(1).max(200)).max(100) })
      .strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid conversation preview request" }); return; }
    try {
      res.json(await readHomeConversationPreviews(options.terminalSessionManager, [...new Set(parsed.data.terminalSessionIds)]));
    } catch {
      res.status(503).json({ message: "Conversation previews unavailable" });
    }
  });

  router.post("/home/branch-status", async (req, res) => {
    const parsed = branchRequest.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid branch status request" }); return; }
    const ids = new Set(parsed.data.terminalSessionIds);
    const sessions = options.terminalSessionManager.listSessions().filter((session) => ids.has(session.id));
    const statuses = await Promise.all(sessions.map((session) =>
      branchStatus.status(session.id, session.cwd, parsed.data.refresh)));
    res.json({ statuses });
  });

  router.get("/home/overview", async (_req, res) => {
    try {
      res.json(
        await buildAppHomeOverviewPayload(
          options.terminalSessionManager,
          options.terminalStateService,
        ),
      );
    } catch (error) {
      appHomeLogger.error("app.home-overview.request.failed", {
        message: "App home overview request failed",
        error,
      });
      res.status(500).json({
        message: "App home overview request failed",
        error: String(error),
      });
    }
  });

  return router;
}
