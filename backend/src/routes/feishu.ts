import { Router, type RequestHandler } from "express";
import { FeishuBridgeError } from "@runweave/shared/feishu/bridge";
import { forwardFeishuNotification } from "../feishu/runtime";
import type { FeishuBridgeConnector } from "../feishu/bridge-connector";
import type { TerminalSessionManager } from "../terminal/manager/manager";
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
  router.post("/notify", feishuNotifyHandler(connector, sessions));
  return router;
}
