import express from "express";
import { z } from "zod";
import type {
  AppServerAgentKind,
  AppServerAgentRunStatus,
  AppServerEventListResponse,
  AppServerSyncStatusResponse,
  AppServerThreadListResponse,
  AppServerThreadDetailResponse,
  AppServerThreadResponse,
  CreateAppServerEventRequest,
} from "@runweave/shared/app-server-events";
import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_SERVICE_NAME,
} from "./singleton.js";
import { rejectNonLoopbackOrigin, requireBearerToken } from "./auth.js";
import type { AppServerEventCenter } from "./event-center.js";
import type { TraeThreadLifecycleReader } from "./trae-thread-lifecycle-reader.js";
import type { CodexThreadDetailReader } from "./codex-app-server-client.js";

const MAX_EVENTS_LIMIT = 500;
const MAX_STATE_LIMIT = 500;

const sourceSchema = z
  .object({
    app: z.enum([
      "app-server",
      "backend",
      "electron",
      "cli",
      "hook",
      "unknown",
    ]),
    instanceId: z.string().trim().min(1),
    pid: z.number().int().positive().optional(),
  })
  .strict();

const scopeSchema = z
  .object({
    projectId: z.string().trim().min(1).nullable().optional(),
    terminalSessionId: z.string().trim().min(1).nullable().optional(),
    terminalPanelId: z.string().trim().min(1).nullable().optional(),
    terminalTmuxPaneId: z.string().trim().min(1).nullable().optional(),
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
        !["claude", "codex", "trae", "traecli", "traex", "unknown"].includes(
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
  serviceInstanceId: string;
  devSessionId: string | null;
  sourceRevision: string | null;
  traeLifecycleReader: TraeThreadLifecycleReader;
  codexThreadDetailReader: CodexThreadDetailReader;
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
      serviceInstanceId: options.serviceInstanceId,
      ...(options.devSessionId ? { devSessionId: options.devSessionId } : {}),
      ...(options.sourceRevision
        ? { sourceRevision: options.sourceRevision }
        : {}),
      capabilities: [
        "event-center-v1",
        "dev-session-identity-v1",
        "provider-thread-lifecycle-v1",
        "thread-detail-v1",
      ],
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

  app.get("/threads", (req, res) => {
    const parsed = parseStateQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ message: parsed.message });
      return;
    }
    const response: AppServerThreadListResponse = {
      threads: options.eventCenter.getStateStore().listThreads(parsed.value),
      latestEventId: options.eventCenter.getLatestId(),
    };
    res.json(response);
  });

  app.get("/threads/:threadId", async (req, res, next) => {
    const thread = options.eventCenter
      .getStateStore()
      .getThread(req.params.threadId);
    if (!thread) {
      res.status(404).json({ message: "Thread not found" });
      return;
    }
    try {
      const detail = options.traeLifecycleReader.supports(thread.agent)
        ? await options.traeLifecycleReader.readThread(
            thread.threadId,
            thread.agent,
          )
        : null;
      const response: AppServerThreadResponse = { thread, detail };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  app.get("/threads/:threadId/detail", async (req, res, next) => {
    const thread = options.eventCenter
      .getStateStore()
      .getThread(req.params.threadId);
    if (!thread) {
      res.status(404).json({ message: "Thread not found" });
      return;
    }
    try {
      const response: AppServerThreadDetailResponse =
        await options.codexThreadDetailReader.readThreadDetail(thread);
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  app.get("/sync/status", (_req, res) => {
    const response: AppServerSyncStatusResponse =
      options.eventCenter.getSyncStatus();
    res.json(response);
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

function parseStateQuery(query: {
  projectId?: unknown;
  terminalSessionId?: unknown;
  terminalPanelId?: unknown;
  agent?: unknown;
  status?: unknown;
  after?: unknown;
  limit?: unknown;
}):
  | {
      ok: true;
      value: {
        projectId: string | null;
        terminalSessionId: string | null;
        terminalPanelId: string | null;
        agent: AppServerAgentKind | null;
        status: AppServerAgentRunStatus | null;
        after: string | null;
        limit: number;
      };
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

  const rawAgent = readOptionalString(query.agent);
  if (rawAgent && !isAgentKind(rawAgent)) {
    return { ok: false, message: "agent is invalid" };
  }
  const agent = rawAgent as AppServerAgentKind | null;

  const rawStatus = readOptionalString(query.status);
  if (rawStatus && !isRunStatus(rawStatus)) {
    return { ok: false, message: "status is invalid" };
  }
  const status = rawStatus as AppServerAgentRunStatus | null;

  return {
    ok: true,
    value: {
      projectId: readOptionalString(query.projectId),
      terminalSessionId: readOptionalString(query.terminalSessionId),
      terminalPanelId: readOptionalString(query.terminalPanelId),
      agent,
      status,
      after: after || null,
      limit: Math.min(limit, MAX_STATE_LIMIT),
    },
  };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAgentKind(value: string): value is AppServerAgentKind {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "trae" ||
    value === "traecli" ||
    value === "traex" ||
    value === "unknown"
  );
}

function isRunStatus(value: string): value is AppServerAgentRunStatus {
  return (
    value === "starting" ||
    value === "running" ||
    value === "idle" ||
    value === "completed" ||
    value === "failed" ||
    value === "unknown"
  );
}
