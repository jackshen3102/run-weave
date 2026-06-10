import type {
  AppHomeOverviewResponse,
  AppHomeOverviewSession,
} from "@browser-viewer/shared";
import { Router } from "express";
import path from "node:path";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  isCodexSession,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import { toProjectPayload, toSessionListItem } from "./terminal-route-payloads";

const appHomeLogger = logger.child({ component: "app-home-overview" });

function basename(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, "");
  return path.basename(normalized) || normalized || value;
}

function buildSessionTitle(
  session: ReturnType<TerminalSessionManager["listSessions"]>[number],
): string {
  const commandLabel = isCodexSession(session)
    ? "codex"
    : session.activeCommand?.trim() || basename(session.command);
  const directoryLabel = basename(session.cwd);
  return directoryLabel ? `${commandLabel} · ${directoryLabel}` : commandLabel;
}

function buildDisplayStatus(
  session: ReturnType<TerminalSessionManager["listSessions"]>[number],
  terminalStateService: TerminalStateService,
): Pick<
  AppHomeOverviewSession,
  "displayStatus" | "displayStatusLabel" | "terminalState"
> {
  const terminalState = terminalStateService.getCurrent(session.id, session);

  if (session.status === "exited") {
    return {
      displayStatus: "exited",
      displayStatusLabel: "Exited",
      terminalState,
    };
  }

  if (terminalState.state === "agent_running") {
    return {
      displayStatus: "running",
      displayStatusLabel: "Agent Running",
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

function sortSessionsForAppHome(
  sessions: ReturnType<TerminalSessionManager["listSessions"]>,
): ReturnType<TerminalSessionManager["listSessions"]> {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const activityDelta =
        right.session.lastActivityAt.getTime() -
        left.session.lastActivityAt.getTime();
      return activityDelta || left.index - right.index;
    })
    .map((entry) => entry.session);
}

export function buildAppHomeOverviewPayload(
  terminalSessionManager: TerminalSessionManager,
  terminalStateService: TerminalStateService,
): AppHomeOverviewResponse {
  return {
    projects: terminalSessionManager
      .listProjects()
      .map((project) => toProjectPayload(project)),
    sessions: sortSessionsForAppHome(terminalSessionManager.listSessions()).map(
      (session) => ({
        ...toSessionListItem(session),
        title: buildSessionTitle(session),
        subtitle: session.cwd,
        ...buildDisplayStatus(session, terminalStateService),
      }),
    ),
  };
}

export function createAppHomeOverviewRouter(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
}) {
  const router = Router();

  router.get("/home/overview", (_req, res) => {
    try {
      res.json(
        buildAppHomeOverviewPayload(
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
