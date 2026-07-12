import { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";
import {
  ACTIVITY_EVENT_NAMES,
  type ActivityEventInput,
  type ActivityFactsQuery,
  type ActivityOperationScope,
  type ActivityRuntimeChannel,
  type ActivityRuntimeSurface,
  type ActivityTimelineSelector,
} from "@runweave/shared/activity";
import crypto from "node:crypto";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import { canonicalActivityScope } from "../activity/canonical";
import type { ActivityQueryService } from "../activity/query-service";
import { listActivitySchemas, parseActivityEvents, type ActivityIngress } from "../activity/registry";
import type { ActivityStore } from "../activity/activity-store";
import { logger } from "../logging";

const factsQuerySchema = z.object({
  runtimeChannel: z.enum(["stable", "beta", "dev", "external"]).optional(),
  runtimeSurface: z.enum(["backend", "desktop", "web", "app", "cli", "hook", "shell"]).optional(),
  projectId: z.string().min(1).max(256).optional(),
  terminalSessionId: z.string().min(1).max(256).optional(),
  threadId: z.string().min(1).max(256).optional(),
  runId: z.string().min(1).max(256).optional(),
  eventName: z.enum(ACTIVITY_EVENT_NAMES).optional(),
  actorType: z.enum(["user", "agent", "system", "unknown"]).optional(),
  resultStatus: z.enum(["succeeded", "failed", "cancelled"]).optional(),
  search: z.string().max(256).optional(),
  cursor: z.string().max(2048).optional(),
  asOfActivityOffset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const timelineQuerySchema = factsQuerySchema.extend({
  selector: z.enum(["interaction", "correlation", "thread", "run"]),
  id: z.string().min(1).max(256),
});

const operationScopeSchema = z
  .object({
    projectId: z.string().min(1).max(256).optional(),
    threadId: z.string().min(1).max(256).optional(),
  })
  .refine((scope) => Number(Boolean(scope.projectId)) + Number(Boolean(scope.threadId)) === 1);
const operationRequestSchema = z.object({
  action: z.enum(["export", "delete"]),
  scope: operationScopeSchema,
});

function asOperationScope(scope: z.infer<typeof operationScopeSchema>): ActivityOperationScope {
  return scope.projectId
    ? { projectId: scope.projectId }
    : { threadId: scope.threadId as string };
}

function resolveRuntimeChannel(env: NodeJS.ProcessEnv): ActivityRuntimeChannel {
  const configured = env.RUNWEAVE_DESKTOP_CHANNEL?.trim().toLowerCase();
  return configured === "stable" || configured === "beta" ? configured : "dev";
}

function normalizeIngressBody(
  body: unknown,
  ingress: ActivityIngress,
  surface: ActivityRuntimeSurface,
): unknown {
  const rawEvents =
    body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
      ? (body as { events: unknown[] }).events
      : [];
  const channel = resolveRuntimeChannel(process.env);
  return {
    events: rawEvents.map((rawEvent) => {
      const event = rawEvent as Partial<ActivityEventInput>;
      const producer = event.producer ?? ({} as ActivityEventInput["producer"]);
      const fixedProducerName =
        ingress === "electron"
          ? "runweave-electron"
          : ingress === "shell"
            ? "runweave-shell"
            : "runweave-agent-hook";
      return {
        ...event,
        producer: {
          ...producer,
          name: fixedProducerName,
          version: process.env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim() || "builtin",
        },
        actor: {
          type: ingress === "hook" ? "agent" : "user",
          ...(event.actor?.agent ? { agent: event.actor.agent } : {}),
        },
        runtime: {
          channel,
          surface,
          ...(process.env.RUNWEAVE_RUNTIME_RELEASE_ID
            ? { sourceRevision: process.env.RUNWEAVE_RUNTIME_RELEASE_ID }
            : {}),
        },
      };
    }),
  };
}

async function writeIngressBatch(params: {
  body: unknown;
  ingress: ActivityIngress;
  surface: ActivityRuntimeSurface;
  store: ActivityStore | null;
}): Promise<{ acknowledgements: Awaited<ReturnType<ActivityStore["record"]>> }> {
  if (!params.store) throw new Error("activity_unavailable");
  try {
    const events = parseActivityEvents(
      normalizeIngressBody(params.body, params.ingress, params.surface),
      params.ingress,
    );
    return { acknowledgements: await params.store.record(events) };
  } catch (error) {
    const rawFirstEvent =
      params.body && typeof params.body === "object" &&
      Array.isArray((params.body as { events?: unknown }).events)
        ? (params.body as { events: unknown[] }).events[0]
        : null;
    const firstEvent = rawFirstEvent && typeof rawFirstEvent === "object"
      ? rawFirstEvent as Record<string, unknown>
      : {};
    const firstProducer = firstEvent.producer && typeof firstEvent.producer === "object"
      ? firstEvent.producer as Record<string, unknown>
      : {};
    const message = error instanceof Error ? error.message : "activity_schema_rejected";
    const reasonCode = message.startsWith("activity_")
      ? message.slice(0, 256)
      : "activity_schema_rejected";
    const requestSha256 = crypto
      .createHash("sha256")
      .update(JSON.stringify(params.body ?? null))
      .digest("hex");
    await params.store.recordRejection({
      requestSha256,
      reasonCode,
      ...(typeof firstEvent.eventName === "string"
        ? { eventName: firstEvent.eventName }
        : {}),
      ...(typeof firstEvent.schemaVersion === "number"
        ? { schemaVersion: firstEvent.schemaVersion }
        : {}),
      ...(typeof firstProducer.name === "string"
        ? { producerName: firstProducer.name }
        : {}),
      ...(typeof firstProducer.instanceId === "string"
        ? { producerInstanceId: firstProducer.instanceId }
        : {}),
      ...(typeof firstProducer.bootId === "string"
        ? { producerBootId: firstProducer.bootId }
        : {}),
    });
    throw new Error(reasonCode);
  }
}

const activityErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  const message = error instanceof Error ? error.message : "activity_request_failed";
  if (response.headersSent) {
    next(error);
    return;
  }
  const status = message === "activity_unavailable"
    ? 503
    : message.includes("not_found")
      ? 404
      : message.startsWith("activity_")
        ? 400
        : 500;
  response.status(status).json({ message: status === 500 ? "activity_request_failed" : message });
};

export function createActivityRouter(options: {
  queryService: ActivityQueryService;
  store: ActivityStore | null;
  authService: AuthService;
  backendInstanceId: string;
}): Router {
  const router = Router();

  router.get("/facts", async (request, response, next) => {
    const parsed = factsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      const query = parsed.data as ActivityFactsQuery;
      response.json(await options.queryService.facts(query));
    } catch (error) {
      next(error);
    }
  });

  router.get("/timelines", async (request, response, next) => {
    const parsed = timelineQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      const selector: ActivityTimelineSelector = {
        type: parsed.data.selector,
        id: parsed.data.id,
      };
      const query = parsed.data as ActivityFactsQuery;
      response.json(await options.queryService.timeline(selector, query));
    } catch (error) {
      next(error);
    }
  });

  router.get("/sources", async (_request, response, next) => {
    try {
      response.json({ sources: await options.queryService.sources() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/policy", async (_request, response, next) => {
    try {
      response.json(await options.queryService.policy());
    } catch (error) {
      next(error);
    }
  });

  router.get("/schemas", (_request, response) => {
    response.json({ schemas: listActivitySchemas() });
  });

  router.get("/contents/:contentId", async (request, response, next) => {
    try {
      if (!options.store) throw new Error("activity_unavailable");
      const accessToken = readBearerToken(request);
      const subject = accessToken
        ? options.authService.getActivityAuditSubject(accessToken)
        : null;
      if (!subject) {
        response.status(401).json({ message: "Unauthorized" });
        return;
      }
      const requestId = crypto.randomUUID();
      const authSubjectHmac = await options.store.auditSubjectHmac(subject);
      const content = await options.store.content(request.params.contentId);
      await options.store.recordAccessAudit({
        requestId,
        backendInstanceId: options.backendInstanceId,
        authSubjectHmac,
        action: "content_read",
        scopeJson: JSON.stringify({ contentId: request.params.contentId }),
        resultStatus: content ? "succeeded" : "failed",
        ...(content ? {} : { resultCode: "activity_content_not_found" }),
      });
      if (!content) {
        response.status(404).json({ message: "activity_content_not_found" });
        return;
      }
      response.json(content);
    } catch (error) {
      next(error);
    }
  });

  router.post("/operations", async (request, response, next) => {
    try {
      if (!options.store) throw new Error("activity_unavailable");
      const accessToken = readBearerToken(request);
      const auditSubject = accessToken
        ? options.authService.getActivityAuditSubject(accessToken)
        : null;
      if (!auditSubject) {
        response.status(401).json({ message: "Unauthorized" });
        return;
      }
      const parsed = operationRequestSchema.parse(request.body);
      const scope = asOperationScope(parsed.scope);
      const snapshot = await options.store.preview(scope);
      if (
        parsed.action === "export" &&
        snapshot.estimatedExportBytes > 128 * 1024 * 1024
      ) {
        response.status(413).json({ message: "activity_export_scope_too_large" });
        return;
      }
      const requestId = crypto.randomUUID();
      const authSubjectHmac = await options.store.auditSubjectHmac(auditSubject);
      if (parsed.action === "export") {
        const facts = await options.store.exportSnapshot({
          scope,
          asOfActivityOffset: snapshot.asOfActivityOffset,
        });
        await options.store.recordAccessAudit({
          requestId,
          backendInstanceId: options.backendInstanceId,
          authSubjectHmac,
          action: "export",
          scopeJson: canonicalActivityScope(scope).canonicalJson,
          resultStatus: "succeeded",
        });
        response.json({
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          scope,
          asOfActivityOffset: snapshot.asOfActivityOffset,
          facts,
        });
        return;
      }

      const deleteJob = await options.store.createDeleteJob({
        requestId,
        backendInstanceId: options.backendInstanceId,
        authSubjectHmac,
        scope,
        snapshot,
      });
      const drain = (): void => {
        void options.store
          ?.runDelete(options.backendInstanceId)
          .then(async (job) => {
            const current = job?.deleteJobId === deleteJob.deleteJobId
              ? job
              : await options.store?.deleteStatus(deleteJob.deleteJobId);
            if (current && current.status !== "completed") {
              setTimeout(drain, 50).unref();
            }
          })
          .catch((error) => {
            logger.warn("activity.delete.drain.failed", {
              component: "activity",
              message: "Activity delete job remains durable and will be retried",
              deleteJobId: deleteJob.deleteJobId,
              error,
            });
            setTimeout(drain, 1_000).unref();
          });
      };
      drain();
      response.status(202).json(deleteJob);
    } catch (error) {
      next(error);
    }
  });

  router.get("/delete-jobs/:deleteJobId", async (request, response, next) => {
    try {
      const job = await options.queryService.deleteStatus(request.params.deleteJobId);
      if (!job) {
        response.status(404).json({ message: "Activity delete job not found" });
        return;
      }
      response.json(job);
    } catch (error) {
      next(error);
    }
  });

  const ingressRoutes: Array<{
    path: string;
    ingress: ActivityIngress;
    surface: ActivityRuntimeSurface;
  }> = [
    { path: "/hook-events/batch", ingress: "hook", surface: "hook" },
    { path: "/electron-events/batch", ingress: "electron", surface: "desktop" },
    { path: "/shell-command-events/batch", ingress: "shell", surface: "shell" },
  ];
  for (const route of ingressRoutes) {
    router.post(route.path, async (request, response, next) => {
      try {
        response.json(
          await writeIngressBatch({
            body: request.body,
            ingress: route.ingress,
            surface: route.surface,
            store: options.store,
          }),
        );
      } catch (error) {
        next(error);
      }
    });
  }

  router.use(activityErrorHandler);

  return router;
}

export function createInternalActivityRouter(options: {
  store: ActivityStore | null;
  hookToken?: string;
}): Router {
  const router = Router();
  router.post("/hook-events/batch", async (request, response, next) => {
    const provided = String(request.headers["x-runweave-hook-token"] ?? "");
    if (!options.hookToken || provided !== options.hookToken) {
      response.status(401).json({ message: "Unauthorized" });
      return;
    }
    try {
      response.json(
        await writeIngressBatch({
          body: request.body,
          ingress: "hook",
          surface: "hook",
          store: options.store,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.use(activityErrorHandler);
  return router;
}
