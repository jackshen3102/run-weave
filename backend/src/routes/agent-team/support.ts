import type { Response } from "express";
import { AgentTeamError } from "../../agent-team/errors";
import { logger } from "../../logging/index";

const agentTeamRouteLogger = logger.child({ component: "agent-team-route" });

export async function handleAgentTeamServiceCall(
  res: Pick<Response, "status" | "json">,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    res.json(await action());
  } catch (error) {
    if (error instanceof AgentTeamError) {
      res.status(error.statusCode).json({
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
      return;
    }
    agentTeamRouteLogger.error("agent-team.request.failed", {
      message: "Agent-team request failed",
      error: error instanceof Error ? error.message : String(error),
    });
    res
      .status(500)
      .json({ message: "Agent-team request failed", error: String(error) });
  }
}
