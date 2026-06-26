import express from "express";
import { z } from "zod";
import type {
  AppServerEventListResponse,
  CreateAppServerEventRequest,
} from "@runweave/shared";
import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_SERVICE_NAME,
} from "./singleton";
import {
  rejectNonLoopbackOrigin,
  requireBearerToken,
} from "./auth";
import type { AppServerEventCenter } from "./event-center";

const MAX_EVENTS_LIMIT = 500;

const sourceSchema = z
  .object({
    app: z.enum(["app-server", "backend", "electron", "cli", "hook", "unknown"]),
    instanceId: z.string().trim().min(1),
    pid: z.number().int().positive().optional(),
  })
  .strict();

const scopeSchema = z
  .object({
    projectId: z.string().trim().min(1).nullable().optional(),
    terminalSessionId: z.string().trim().min(1).nullable().optional(),
    runId: z.string().trim().min(1).nullable().optional(),
    cwd: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

const eventRequestSchema = z
  .object({
    kind: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    source: sourceSchema,
    scope: scopeSchema.optional(),
    dedupeKey: z.string().trim().min(1).nullable().optional(),
    correlationId: z.string().trim().min(1).nullable().optional(),
    payload: z.custom<unknown>((value) => value !== undefined, {
      message: "payload is required",
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.kind === "agent.hook" || value.kind === "agent.completion") &&
      !value.scope?.terminalSessionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "terminalSessionId"],
        message: "terminalSessionId is required for hook events",
      });
    }
    if (
      (value.kind === "agent.hook" || value.kind === "agent.completion") &&
      (!value.payload ||
        typeof value.payload !== "object" ||
        Array.isArray(value.payload))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "hook payload must be an object",
      });
    }
    if (value.kind === "agent.completion") {
      const payload = value.payload as Record<string, unknown>;
      if (
        !["claude", "codex", "trae", "unknown"].includes(
          String(payload.source),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "source"],
          message: "invalid hook source",
        });
      }
      if (
        !["hook_stop", "notify", "ai_process_exit", "manual"].includes(
          String(payload.completionReason),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "completionReason"],
          message: "invalid completion reason",
        });
      }
    }
  });

export function createHttpApp(options: {
  eventCenter: AppServerEventCenter;
  token: string;
  version: string;
}): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(rejectNonLoopbackOrigin);

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: APP_SERVER_SERVICE_NAME,
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      pid: process.pid,
      version: options.version,
    });
  });

  app.get("/readyz", (_req, res) => {
    res.json({ ready: true });
  });

  app.use(requireBearerToken(options.token));

  app.post("/events", async (req, res) => {
    const parsed = eventRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const request = parsed.data as CreateAppServerEventRequest;
    const result = await options.eventCenter.record(request);
    res.status(result.created ? 201 : 200).json({ event: result.event });
  });

  app.get("/events", (req, res) => {
    const parsed = parseEventsQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ message: parsed.message });
      return;
    }

    const response: AppServerEventListResponse = {
      events: options.eventCenter.listAfter(parsed.value),
      latestEventId: options.eventCenter.getLatestId(),
    };
    res.json(response);
  });

  app.get("/events/latest", (_req, res) => {
    res.json({ latestEventId: options.eventCenter.getLatestId() });
  });

  return app;
}

export function parseEventsQuery(query: {
  after?: unknown;
  kind?: unknown;
  limit?: unknown;
}):
  | {
      ok: true;
      value: { after: string | null; kinds: string[]; limit: number };
    }
  | { ok: false; message: string } {
  const after = typeof query.after === "string" ? query.after.trim() : "";
  if (after && !/^\d+$/.test(after)) {
    return { ok: false, message: "after must be a numeric event id" };
  }

  const rawLimit = typeof query.limit === "string" ? query.limit.trim() : "";
  const limit = rawLimit ? Number(rawLimit) : 100;
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, message: "limit must be a positive integer" };
  }

  const rawKinds = Array.isArray(query.kind) ? query.kind : [query.kind];
  const kinds = rawKinds
    .filter((kind): kind is string => typeof kind === "string")
    .map((kind) => kind.trim())
    .filter(Boolean);

  return {
    ok: true,
    value: {
      after: after || null,
      kinds,
      limit: Math.min(limit, MAX_EVENTS_LIMIT),
    },
  };
}
