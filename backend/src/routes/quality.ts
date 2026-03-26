import { Router } from "express";
import type { SessionQualityResponse } from "@browser-viewer/shared";
import { QualityProbeStore } from "../quality/probe-store";
import { WebSocketSessionController } from "../ws/session-control";

export function createQualityRouter(
  qualityProbeStore: QualityProbeStore,
  wsSessionController?: WebSocketSessionController,
): Router {
  const router = Router();

  router.get("/quality/session/:id/connections", (req, res) => {
    if (!wsSessionController) {
      res.status(503).json({ message: "WebSocket session control unavailable" });
      return;
    }

    res.json({
      connectionCount: wsSessionController.getSessionConnectionCount(
        req.params.id,
      ),
    });
  });

  router.get("/quality/session/:id", (req, res) => {
    const payload = qualityProbeStore.getSession(req.params.id);
    if (!payload) {
      res.status(404).json({ message: "Quality session not found" });
      return;
    }

    res.json(payload satisfies SessionQualityResponse);
  });

  router.post("/quality/session/:id/reset", (req, res) => {
    const reset = qualityProbeStore.resetSession(req.params.id);
    if (!reset) {
      res.status(404).json({ message: "Quality session not found" });
      return;
    }

    const payload = qualityProbeStore.getSession(req.params.id);
    if (!payload) {
      res.status(404).json({ message: "Quality session not found" });
      return;
    }
    res.json(payload satisfies SessionQualityResponse);
  });

  router.post("/quality/session/:id/disconnect", (req, res) => {
    if (!wsSessionController) {
      res.status(503).json({ message: "WebSocket session control unavailable" });
      return;
    }

    const disconnected = wsSessionController.disconnectSession(req.params.id);
    if (!disconnected) {
      res.status(404).json({ message: "Active websocket session not found" });
      return;
    }

    res.status(202).json({ disconnected: true });
  });

  return router;
}
