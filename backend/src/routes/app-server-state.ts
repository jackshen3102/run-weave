import { Router } from "express";
import type {
  AppServerThreadListResponse,
  AppServerThreadResponse,
} from "@runweave/shared";
import { discoverAppServer } from "@runweave/shared/src/app-server-node";

const MAX_LIMIT = 100;
const AGENT_VALUES = new Set([
  "claude",
  "codex",
  "trae",
  "traecli",
  "traex",
  "unknown",
]);
const STATUS_VALUES = new Set([
  "starting",
  "running",
  "idle",
  "completed",
  "failed",
  "unknown",
]);

type StateQuery =
  | { ok: true; params: URLSearchParams }
  | { ok: false; message: string };

export function createAppServerStateRouter(): Router {
  const router = Router();

  router.get("/threads", async (req, res, next) => {
    try {
      const parsed = parseStateQuery(req.query);
      if (!parsed.ok) {
        res.status(400).json({ message: parsed.message });
        return;
      }

      const response = await requestAppServer(
        `/threads?${parsed.params.toString()}`,
      );
      if (!response.ok) {
        if (response.status === 400) {
          res.status(400).json({ message: "Invalid query" });
          return;
        }
        res.status(503).json({ message: "App Server unavailable" });
        return;
      }

      res.json((await response.json()) as AppServerThreadListResponse);
    } catch (error) {
      next(error);
    }
  });

  router.get("/threads/:threadId", async (req, res, next) => {
    try {
      const threadId = req.params.threadId.trim();
      if (!threadId) {
        res.status(400).json({ message: "Invalid thread id" });
        return;
      }

      const response = await requestAppServer(
        `/threads/${encodeURIComponent(threadId)}`,
      );
      if (!response.ok) {
        if (response.status === 404) {
          res.status(404).json({ message: "Thread not found" });
          return;
        }
        res.status(503).json({ message: "App Server unavailable" });
        return;
      }

      res.json((await response.json()) as AppServerThreadResponse);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function requestAppServer(pathname: string): Promise<Response> {
  const connection = await discoverAppServer({ env: process.env });
  if (!connection) {
    return new Response(null, { status: 503 });
  }

  try {
    return await fetch(`${connection.baseUrl}${pathname}`, {
      headers: {
        Authorization: `Bearer ${connection.token}`,
      },
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}

function parseStateQuery(query: Record<string, unknown>): StateQuery {
  const params = new URLSearchParams();
  const stringFields = [
    "projectId",
    "terminalSessionId",
    "terminalPanelId",
    "after",
  ] as const;

  for (const field of stringFields) {
    const value = readOptionalString(query[field]);
    if (value) {
      params.set(field, value);
    }
  }

  const agent = readOptionalString(query.agent);
  if (agent) {
    if (!AGENT_VALUES.has(agent)) {
      return { ok: false, message: "Invalid query" };
    }
    params.set("agent", agent);
  }

  const status = readOptionalString(query.status);
  if (status) {
    if (!STATUS_VALUES.has(status)) {
      return { ok: false, message: "Invalid query" };
    }
    params.set("status", status);
  }

  const rawLimit = readOptionalString(query.limit);
  if (rawLimit) {
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      return { ok: false, message: "Invalid query" };
    }
    params.set("limit", String(Math.min(limit, MAX_LIMIT)));
  }

  return { ok: true, params };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
