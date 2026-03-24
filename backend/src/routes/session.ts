import { Router } from "express";
import { z } from "zod";
import type {
  CreateSessionSource,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionListItem,
  SessionStatusResponse,
} from "@browser-viewer/shared";
import type { SessionManager } from "../session/manager";

const launchSourceSchema = z.object({
  type: z.literal("launch"),
  proxyEnabled: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const connectCdpSourceSchema = z.object({
  type: z.literal("connect-cdp"),
  endpoint: z.string().trim().url(),
});

const createSessionSchema = z.object({
  url: z.string().url(),
  source: z.union([launchSourceSchema, connectCdpSourceSchema]).optional(),
});

function normalizeCreateSessionSource(
  source: CreateSessionRequest["source"],
): CreateSessionSource {
  return source ?? { type: "launch" };
}

export function createSessionRouter(sessionManager: SessionManager): Router {
  const router = Router();

  router.get("/session", (_req, res) => {
    const payload: SessionListItem[] = sessionManager
      .listSessions()
      .map((session) => ({
        sessionId: session.id,
        connected: session.connected,
        targetUrl: session.targetUrl,
        proxyEnabled: session.proxyEnabled,
        sourceType: session.sourceType,
        headers: session.headers,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
      }));

    res.json(payload);
  });

  router.post("/session", async (req, res) => {
    const parsed = createSessionSchema.safeParse(
      req.body as CreateSessionRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const source = normalizeCreateSessionSource(parsed.data.source);
      const session = await sessionManager.createSession({
        targetUrl: parsed.data.url,
        source,
      });
      const payload: CreateSessionResponse = {
        sessionId: session.id,
        viewerUrl: `/?sessionId=${session.id}`,
      };
      res.status(201).json(payload);
    } catch (error) {
      console.error("[viewer-be] create session failed", {
        error: String(error),
      });
      res
        .status(500)
        .json({ message: "Failed to create session", error: String(error) });
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
      proxyEnabled: session.proxyEnabled,
      sourceType: session.sourceType,
      headers: session.headers,
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
