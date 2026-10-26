import type { Router } from "express";
import type { UpdateTerminalSessionRequest } from "@runweave/shared/terminal/session";
import type { TerminalSessionManager } from "../../../terminal/manager/manager";
import type { TerminalStateService } from "../../../terminal/state/terminal-state-service";
import type { TerminalEventService } from "../../../terminal/state/terminal-event-service";
import { toPanelWorkspacePayload, toSessionListItem } from "../../../terminal/application/payloads";
import { resolveEffectiveTerminalState } from "../../../terminal/application/terminal-state-projection";
import { logger } from "../../../logging/index";
import { updateTerminalSessionSchema } from "./helpers";

const terminalLogger = logger.child({ component: "terminal" });

export function registerTerminalSessionUpdateRoute(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  terminalStateService?: TerminalStateService,
  terminalEventService?: TerminalEventService,
): void {
  router.patch("/session/:id", async (req, res) => {
    const parsed = updateTerminalSessionSchema.safeParse(
      req.body as UpdateTerminalSessionRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    try {
      let updatedSession = session;
      if (parsed.data.projectId !== undefined) {
        const projectId = parsed.data.projectId;
        if (!terminalSessionManager.listProjects().some((project) => project.id === projectId)) {
          res.status(404).json({ message: "Target project not found" });
          return;
        }
        const moved = await terminalSessionManager.moveSession(session.id, projectId);
        if (!moved) { res.status(404).json({ message: "Terminal session not found" }); return; }
        updatedSession = moved.session;
        if (moved.previousProjectId !== projectId) {
          terminalEventService?.record({
            kind: "terminal_session_moved",
            terminalSessionId: session.id,
            projectId: updatedSession.projectId,
            payload: {
              previousProjectId: moved.previousProjectId,
              session: toSessionListItem(updatedSession,
                resolveEffectiveTerminalState(terminalSessionManager, terminalStateService, updatedSession),
                toPanelWorkspacePayload(terminalSessionManager, session.id)),
            },
          });
        }
      }
      if (parsed.data.alias !== undefined) {
        updatedSession =
          (await terminalSessionManager.updateSessionAlias(
            session.id,
            parsed.data.alias,
          )) ?? updatedSession;
      }
      if (parsed.data.pinned !== undefined) {
        updatedSession =
          (await terminalSessionManager.setSessionPinned(session.id, parsed.data.pinned)) ?? updatedSession;
      }
      if (parsed.data.panelSplitEnabled !== undefined) {
        const runningPanelCount = terminalSessionManager
          .listPanels(session.id)
          .filter((panel) => panel.status === "running").length;
        if (
          parsed.data.panelSplitEnabled === false &&
          session.panelSplitEnabled &&
          runningPanelCount > 1
        ) {
          res.status(409).json({
            message: "Close extra panels before disabling panel split.",
          });
          return;
        }
        updatedSession =
          (await terminalSessionManager.updateSessionPanelSplitEnabled(
            session.id,
            parsed.data.panelSplitEnabled,
          )) ?? updatedSession;
      }
      if (parsed.data.acknowledgedCompletionRevision !== undefined) {
        updatedSession =
          (await terminalSessionManager.acknowledgeSessionCompletion(
            session.id,
            parsed.data.acknowledgedCompletionRevision,
          )) ?? updatedSession;
      }
      res.json(
        toSessionListItem(
          updatedSession,
          resolveEffectiveTerminalState(
            terminalSessionManager,
            terminalStateService,
            updatedSession,
          ),
          toPanelWorkspacePayload(terminalSessionManager, session.id),
        ),
      );
    } catch (error) {
      terminalLogger.error("terminal.session.update.failed", {
        message: "Terminal session update failed",
        terminalSessionId: session.id,
        error,
      });
      res.status(500).json({
        message: "Terminal session update failed",
        error: String(error),
      });
    }
  });
}
