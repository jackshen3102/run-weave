import type { AppHomeOverviewResponse, AppHomeOverviewSession } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import { Router } from "express";
import path from "node:path";
import { logger } from "../logging";
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

  if (getTerminalSessionAgent(session) !== "codex") {
    return undefined;
  }

  return session.preview?.trim() || undefined;
}

function resolveEffectiveThreadId(
  session: TerminalSession,
): string | undefined {
  return getTerminalSessionAgent(session) === "codex"
    ? session.threadId
    : undefined;
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
    getTerminalSessionAgent(session) !== "codex" ||
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

  const terminalState: TerminalState =
    codexThreadSnapshot.statusType === "active"
      ? { state: "agent_running", agent: "codex" }
      : { state: "agent_idle", agent: "codex" };

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
    getTerminalSessionAgent(session) !== "codex" ||
    !session.threadId
  ) {
    return null;
  }

  try {
    return await readCodexThreadSnapshot(session.threadId);
  } catch (error) {
    appHomeLogger.warn("app.home-overview.codex-thread.read-failed", {
      message: "Failed to read Codex thread while building app home overview",
      terminalSessionId: session.id,
      threadId: session.threadId,
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
        await readCodexThreadOverviewSnapshot(session);
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
