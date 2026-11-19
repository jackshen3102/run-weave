import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { logger } from "../logging/index";
import { FeishuBridgeError } from "@runweave/shared/feishu/bridge";
import { forwardFeishuNotification } from "../feishu/runtime";
import type { FeishuBridgeConnector } from "../feishu/bridge-connector";
import type { TerminalSessionManager } from "../terminal/manager/manager";
export function feishuNotificationPolicyHandler(sessions: TerminalSessionManager): RequestHandler {
  return async (req, res) => {
    const parsed = z.object({
      terminalSessionId: z.string().min(1),
      notificationId: z.union([z.string().uuid(), z.string().regex(/^[1-9]\d{0,15}$/)]),
      claim: z.boolean(),
    }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid notification request" }); return; }
    try {
      res.json(await sessions.feishuNotifications.decide(
        parsed.data.terminalSessionId, parsed.data.notificationId, parsed.data.claim,
      ));
    } catch (error) {
      logger.warn("terminal-completion.feishu-policy.failed", { error });
      res.status(503).json({ message: "Notification policy unavailable" });
    }
  };
}
export function feishuNotifyHandler(
  connector: FeishuBridgeConnector | undefined,
  sessions: TerminalSessionManager,
): RequestHandler {
  return async (req, res) => {
    try {
      res.json(await forwardFeishuNotification(connector, sessions, req.body));
    } catch (error) {
      const code =
        error instanceof FeishuBridgeError ? error.code : "input_unknown";
      const status =
        code === "invalid_request"
          ? 400
          : code === "not_found"
            ? 404
            : code === "busy"
              ? 429
              : 503;
      res.status(status).json({ error: code });
    }
  };
}
export function createFeishuRouter(
  connector: FeishuBridgeConnector | undefined,
  sessions: TerminalSessionManager,
): Router {
  const router = Router();
  router.post("/notification-policy", feishuNotificationPolicyHandler(sessions));
  router.post("/notify", feishuNotifyHandler(connector, sessions));
  return router;
}
