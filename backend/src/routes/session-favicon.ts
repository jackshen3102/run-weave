import { Buffer } from "node:buffer";
import { Router } from "express";
import type { RequestHandler } from "express";
import type { Page } from "playwright";
import type { SessionManager } from "../session/manager";
import { resolvePageByTargetId } from "../ws/tab-target";
import { resolveTabFaviconUrl } from "../ws/tabs";

interface FaviconPayload {
  body: Buffer;
  contentType: string;
}

interface CachedFaviconPayload extends FaviconPayload {
  expiresAt: number;
}

interface CreateSessionFaviconHandlerOptions {
  sessionManager: SessionManager;
  cacheTtlMs?: number;
  now?: () => number;
  fetchFaviconForPage?: (params: {
    page: Page;
    faviconUrl: string;
  }) => Promise<FaviconPayload | null>;
  resolvePageForSessionTab?: (params: {
    sessionManager: SessionManager;
    sessionId: string;
    tabId: string;
  }) => Promise<Page | null>;
  resolveTabFaviconUrlForPage?: (page: Page) => Promise<string | null>;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FAVICON_CONTENT_TYPE = "image/x-icon";
const ICON_ACCEPT_HEADER =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

function inferDataUrlPayload(value: string): FaviconPayload | null {
  const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) {
    return null;
  }

  const [, rawContentType, base64Marker, rawBody = ""] = match;
  const contentType = rawContentType || DEFAULT_FAVICON_CONTENT_TYPE;
  try {
    const body = base64Marker
      ? Buffer.from(rawBody, "base64")
      : Buffer.from(decodeURIComponent(rawBody), "utf8");
    return { body, contentType };
  } catch {
    return null;
  }
}

async function defaultFetchFaviconForPage(params: {
  page: Page;
  faviconUrl: string;
}): Promise<FaviconPayload | null> {
  if (params.faviconUrl.startsWith("data:")) {
    return inferDataUrlPayload(params.faviconUrl);
  }

  const response = await params.page.context().request.get(params.faviconUrl, {
    failOnStatusCode: false,
    headers: {
      Accept: ICON_ACCEPT_HEADER,
      Referer: params.page.url(),
    },
  });

  if (!response.ok()) {
    return null;
  }

  const headers = response.headers();
  const body = Buffer.from(await response.body());
  return {
    body,
    contentType: headers["content-type"] ?? DEFAULT_FAVICON_CONTENT_TYPE,
  };
}

async function defaultResolvePageForSessionTab(params: {
  sessionManager: SessionManager;
  sessionId: string;
  tabId: string;
}): Promise<Page | null> {
  const session = params.sessionManager.getSession(params.sessionId);
  if (!session) {
    return null;
  }

  return resolvePageByTargetId(session.browserSession.context, params.tabId);
}

function sendFaviconResponse(
  res: {
    setHeader: (name: string, value: string) => void;
    status: (code: number) => { send: (body: Buffer) => void };
  },
  payload: FaviconPayload,
  cacheTtlMs: number,
): void {
  res.setHeader("Content-Type", payload.contentType);
  res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
  res.status(200).send(payload.body);
}

export function createSessionFaviconRouter(
  options: CreateSessionFaviconHandlerOptions,
): Router {
  const router = Router();
  router.get(
    "/session/:id/tabs/:tabId/favicon",
    createSessionFaviconHandler(options),
  );
  return router;
}

export function createSessionFaviconHandler(
  options: CreateSessionFaviconHandlerOptions,
): RequestHandler {
  const cache = new Map<string, CachedFaviconPayload>();
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const fetchFaviconForPage =
    options.fetchFaviconForPage ?? defaultFetchFaviconForPage;
  const resolvePageForSessionTab =
    options.resolvePageForSessionTab ?? defaultResolvePageForSessionTab;
  const resolveTabFaviconUrlForPage =
    options.resolveTabFaviconUrlForPage ?? resolveTabFaviconUrl;

  return async (req, res) => {
    const sessionId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;
    const tabId = Array.isArray(req.params.tabId)
      ? req.params.tabId[0]
      : req.params.tabId;
    if (!sessionId || !tabId) {
      res.status(400).json({ message: "Missing session or tab id" });
      return;
    }

    const session = options.sessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }

    const page = await resolvePageForSessionTab({
      sessionManager: options.sessionManager,
      sessionId,
      tabId,
    });
    if (!page) {
      res.status(404).json({ message: "Tab not found" });
      return;
    }

    const faviconUrl = await resolveTabFaviconUrlForPage(page);
    if (!faviconUrl) {
      res.status(404).json({ message: "Favicon not found" });
      return;
    }

    const cacheKey = `${sessionId}:${tabId}:${faviconUrl}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      sendFaviconResponse(res, cached, cacheTtlMs);
      return;
    }
    cache.delete(cacheKey);

    try {
      const payload = await fetchFaviconForPage({ page, faviconUrl });
      if (!payload) {
        res.status(404).json({ message: "Favicon not found" });
        return;
      }

      cache.set(cacheKey, {
        ...payload,
        expiresAt: now() + cacheTtlMs,
      });
      sendFaviconResponse(res, payload, cacheTtlMs);
    } catch (error) {
      console.error("[viewer-be] favicon proxy failed", {
        sessionId,
        tabId,
        error: String(error),
      });
      res.status(502).json({ message: "Failed to load favicon" });
    }
  };
}
