import type { AppHomeOverviewResponse, AppHomeOverviewSession } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import { discoverAppServer } from "@runweave/shared/app-server/discovery";
import { Router } from "express";
import path from "node:path";
import { logger } from "../logging";
import { AppServerClient } from "../app-server/client";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  readCodexThreadSnapshot,
  type CodexThreadStatusType,
} from "../terminal/codex-thread-snapshot";
import {
  getTerminalSessionAgent,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import {
  toProjectPayload,
  toSessionListItem,
} from "../terminal/application/payloads";

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

function buildSessionSubtitle(
  session: TerminalSession,
  codexThreadSnapshot?: CodexThreadOverviewSnapshot | null,
): string {
  return resolveEffectivePreview(session, codexThreadSnapshot) ?? session.cwd;
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
  terminalStateService: TerminalStateService,
  codexThreadSnapshot?: CodexThreadOverviewSnapshot | null,
): DisplayStatusPayload {
  const terminalState = terminalStateService.getCurrent(session.id, session);

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
  try {
    const connection = await discoverAppServer({ env: process.env });
    if (!connection) {
      return null;
    }
    const response = await new AppServerClient(connection).getThread(
      identity.id,
    );
    if (!response?.detail) {
      return null;
    }
    return {
      preview: response.detail.preview,
      statusType:
        response.detail.status === "running" ? "active" : "idle",
    };
  } catch (error) {
    appHomeLogger.warn("app.home-overview.agent-thread.read-failed", {
      message: "Failed to read provider thread while building app home overview",
      provider: identity.provider,
      terminalSessionId: session.id,
      threadId: identity.id,
      error,
    });
    return null;
  }
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

      return {
        ...toSessionListItem(session),
        threadId: resolveEffectiveThreadId(session),
        preview: resolveEffectivePreview(session, codexThreadSnapshot),
        title: buildSessionTitle(session),
        subtitle: buildSessionSubtitle(session, codexThreadSnapshot),
        ...buildDisplayStatus(
          session,
          terminalStateService,
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
