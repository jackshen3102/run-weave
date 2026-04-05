import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { readBearerToken } from "../auth/middleware";
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

const execFileAsync = promisify(execFile);
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

function normalizePort(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value <= 0 || value > 65535) {
    return null;
  }
  return value;
}

function extractPortFromUrl(value: string): number | null {
  try {
    const url = new URL(value);
    if (!url.port) {
      return null;
    }
    return normalizePort(Number(url.port));
  } catch {
    return null;
  }
}

function extractPortFromText(output: string): number | null {
  const urlMatch = output.match(
    /(?:ws|wss|http|https):\/\/[^\s:]+:(\d{2,5})/,
  );
  if (urlMatch) {
    return normalizePort(Number(urlMatch[1]));
  }

  const portMatch = output.match(
    /(?:remote-debugging-port|cdp_port|cdpPort|port)\s*[:=]\s*(\d{2,5})/i,
  );
  if (portMatch) {
    return normalizePort(Number(portMatch[1]));
  }

  return null;
}

function extractPortFromJson(value: unknown): number | null {
  if (typeof value === "number") {
    return normalizePort(value);
  }

  if (typeof value === "string") {
    const urlPort = extractPortFromUrl(value);
    if (urlPort) {
      return urlPort;
    }
    const textPort = extractPortFromText(value);
    if (textPort) {
      return textPort;
    }
    return normalizePort(Number(value));
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const port = extractPortFromJson(item);
      if (port) {
        return port;
      }
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const port = extractPortFromJson(entry);
      if (port) {
        return port;
      }
    }
  }

  return null;
}

function resolveCdpEndpointFromStatusOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const portFromJson = extractPortFromJson(parsed);
    if (portFromJson) {
      return `http://127.0.0.1:${portFromJson}`;
    }
  } catch {
    // ignore json parse errors
  }

  const portFromText = extractPortFromText(trimmed);
  if (portFromText) {
    return `http://127.0.0.1:${portFromText}`;
  }

  return null;
}

async function resolveDefaultCdpEndpoint(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", [
      "browser",
      "status",
    ]);
    const output = [stdout, stderr].filter(Boolean).join("\n");
    const endpoint = resolveCdpEndpointFromStatusOutput(output);
    if (endpoint) {
      return endpoint;
    }
    console.warn(
      "[viewer-be] resolve default CDP endpoint failed, fallback to 9222",
    );
    return DEFAULT_CDP_ENDPOINT;
  } catch (error) {
    console.error("[viewer-be] resolve default CDP endpoint failed", {
      error: String(error),
    });
    return DEFAULT_CDP_ENDPOINT;
  }
}

function normalizeCreateSessionSource(
  source: CreateSessionRequest["source"],
): CreateSessionSource {
  return source ?? { type: "launch" };
}

function resolveAuthenticatedSessionId(
  authService: AuthService,
  authorizationHeader: string | undefined,
): string | null {
  const token = readBearerToken({
    headers: { authorization: authorizationHeader },
  } as never);
  if (!token) {
    return null;
  }
  return authService.verifyAccessToken(token)?.sessionId ?? null;
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

  router.get("/session/cdp-endpoint-default", async (_req, res) => {
    const endpoint = await resolveDefaultCdpEndpoint();
    res.json({ endpoint });
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

  router.post("/session/:id/ws-ticket", (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }
    const authSessionId = resolveAuthenticatedSessionId(
      authService,
      req.headers.authorization,
    );
    if (!authSessionId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const issued = authService.issueTemporaryToken({
      sessionId: authSessionId,
      tokenType: "viewer-ws",
      resource: { sessionId: session.id },
      ttlMs: 60_000,
    });
    res.status(200).json({
      ticket: issued.token,
      expiresIn: issued.expiresIn,
    });
  });

  router.post("/session/:id/devtools-ticket", (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }
    const authSessionId = resolveAuthenticatedSessionId(
      authService,
      req.headers.authorization,
    );
    if (!authSessionId) {
      res.status(401).json({ message: "Unauthorized" });
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

    const issued = authService.issueTemporaryToken({
      sessionId: authSessionId,
      tokenType: "devtools",
      resource: { sessionId: session.id, tabId: parsed.data.tabId },
      ttlMs: 60_000,
    });
    const payload: CreateDevtoolsTicketResponse = {
      ticket: issued.token,
      expiresIn: issued.expiresIn,
    };
    res.status(200).json(payload);
  });

  return router;
}
