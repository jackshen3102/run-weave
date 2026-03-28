import { Router } from "express";
import { z } from "zod";
import type {
  CreateDevtoolsTicketRequest,
  CreateDevtoolsTicketResponse,
  CreateSessionSource,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionListItem,
  SessionStatusResponse,
  UpdateSessionRequest,
} from "@browser-viewer/shared";
import type { AuthService } from "../auth/service";
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
  name: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  source: z.union([launchSourceSchema, connectCdpSourceSchema]).optional(),
}).refine((value) => Boolean(value.name ?? value.url), {
  message: "Either name or url is required",
  path: ["name"],
});

const updateSessionSchema = z.object({
  name: z.string().trim().min(1),
});

const createDevtoolsTicketSchema = z.object({
  tabId: z.string().min(1),
});

function normalizeCreateSessionSource(
  source: CreateSessionRequest["source"],
): CreateSessionSource {
  return source ?? { type: "launch" };
}

export function createSessionRouter(
  sessionManager: SessionManager,
  authService: AuthService,
): Router {
  const router = Router();

  router.get("/session", (_req, res) => {
    const payload: SessionListItem[] = sessionManager
      .listSessions()
      .map((session) => ({
        sessionId: session.id,
        connected: session.connected,
        name: session.name,
        proxyEnabled: session.proxyEnabled,
        sourceType: session.sourceType,
        cdpEndpoint: session.cdpEndpoint,
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
      const sessionName = parsed.data.name ?? parsed.data.url;
      if (!sessionName) {
        res.status(400).json({ message: "Invalid request body" });
        return;
      }
      const session = await sessionManager.createSession({
        name: sessionName,
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
      name: session.name,
      proxyEnabled: session.proxyEnabled,
      sourceType: session.sourceType,
      cdpEndpoint: session.cdpEndpoint,
      headers: session.headers,
      createdAt: session.createdAt.toISOString(),
    };

    res.json(payload);
  });

  router.patch("/session/:id", async (req, res) => {
    const parsed = updateSessionSchema.safeParse(req.body as UpdateSessionRequest);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = await sessionManager.updateSessionName(
      req.params.id,
      parsed.data.name,
    );
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }

    const payload: SessionStatusResponse = {
      sessionId: session.id,
      connected: session.connected,
      name: session.name,
      proxyEnabled: session.proxyEnabled,
      sourceType: session.sourceType,
      cdpEndpoint: session.cdpEndpoint,
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

  router.post("/session/:id/devtools-ticket", (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }

    const parsed = createDevtoolsTicketSchema.safeParse(
      req.body as CreateDevtoolsTicketRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const issued = authService.issueTemporaryToken("devtools", 60_000);
    const payload: CreateDevtoolsTicketResponse = {
      ticket: issued.token,
      expiresIn: issued.expiresIn,
    };
    res.status(200).json(payload);
  });

  return router;
}
