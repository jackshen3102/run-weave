import { Router } from "express";
import { z } from "zod";
import type { CreateSessionRequest, CreateSessionResponse, SessionStatusResponse } from "@browser-viewer/shared";
import type { SessionManager } from "../session/manager";

const createSessionSchema = z.object({
  url: z.string().url(),
});

export function createSessionRouter(sessionManager: SessionManager): Router {
  const router = Router();

  router.post("/session", async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body as CreateSessionRequest);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }

    try {
      const session = await sessionManager.createSession(parsed.data.url);
      const payload: CreateSessionResponse = {
        sessionId: session.id,
        viewerUrl: `/viewer?sessionId=${session.id}`,
      };
      res.status(201).json(payload);
    } catch (error) {
      res.status(500).json({ message: "Failed to create session", error: String(error) });
    }
  });

  router.get("/session/:id", (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }

    const payload: SessionStatusResponse = {
      sessionId: session.id,
      connected: session.connected,
      targetUrl: session.targetUrl,
      createdAt: session.createdAt.toISOString(),
    };

    res.json(payload);
  });

  router.delete("/session/:id", async (req, res) => {
    const deleted = await sessionManager.destroySession(req.params.id);
    if (!deleted) {
      res.status(404).json({ message: "Session not found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}
