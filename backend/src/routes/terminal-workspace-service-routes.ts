import type { RequestHandler, Router } from "express";
import { z } from "zod";
import type { StartWorkspaceServiceRequest } from "@runweave/shared/terminal/workspace-service";
import { isLocalDirectHttpRequest } from "../server/local-request";
import type { WorkspaceServiceManager } from "../terminal/workspace-service/manager";
import { WorkspaceServiceRequestError } from "../terminal/workspace-service/errors";
import { logger } from "../logging";

const workspaceServiceRouteLogger = logger.child({
  component: "workspace-service-route",
});

const startWorkspaceServiceSchema = z
  .object({ configRevision: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
const workspaceServiceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);

function parseServiceName(
  value: string,
  response: Parameters<RequestHandler>[1],
): string | null {
  const parsed = workspaceServiceNameSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  response.status(400).json({ message: "Invalid Workspace Service name" });
  return null;
}

const requireLocalDirectRequest: RequestHandler = (request, response, next) => {
  if (!isLocalDirectHttpRequest(request)) {
    response.status(403).json({
      code: "local_request_required",
      message: "Workspace Services are available only from this computer",
    });
    return;
  }
  next();
};

function handleWorkspaceServiceRouteError(
  response: Parameters<RequestHandler>[1],
  error: unknown,
): void {
  if (error instanceof WorkspaceServiceRequestError) {
    response.status(error.statusCode).json({
      code: error.code,
      message: error.message,
    });
    return;
  }
  workspaceServiceRouteLogger.error("workspace-service.request.failed", {
    message: "Workspace service request failed",
    error,
  });
  response.status(500).json({ message: "Workspace service request failed" });
}

export function registerTerminalWorkspaceServiceRoutes(
  router: Router,
  manager: WorkspaceServiceManager,
): void {
  const basePath = "/project/:parentProjectId/contexts/:projectId/services";
  router.use(basePath, requireLocalDirectRequest);

  router.get(basePath, async (request, response) => {
    try {
      response.json(
        await manager.list(
          request.params.parentProjectId,
          request.params.projectId,
        ),
      );
    } catch (error) {
      handleWorkspaceServiceRouteError(response, error);
    }
  });

  router.post(`${basePath}/:serviceName/start`, async (request, response) => {
    const serviceName = parseServiceName(request.params.serviceName, response);
    if (!serviceName) return;
    const parsed = startWorkspaceServiceSchema.safeParse(
      request.body as StartWorkspaceServiceRequest,
    );
    if (!parsed.success) {
      response.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      const result = await manager.start({
        parentProjectId: request.params.parentProjectId,
        projectId: request.params.projectId,
        serviceName,
        configRevision: parsed.data.configRevision,
      });
      response.status(result.accepted ? 202 : 200).json(result);
    } catch (error) {
      handleWorkspaceServiceRouteError(response, error);
    }
  });

  router.post(`${basePath}/:serviceName/stop`, async (request, response) => {
    if (
      (request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0") ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      response.status(400).json({ message: "Request body is not supported" });
      return;
    }
    const serviceName = parseServiceName(request.params.serviceName, response);
    if (!serviceName) return;
    try {
      response.json(
        await manager.stop({
          parentProjectId: request.params.parentProjectId,
          projectId: request.params.projectId,
          serviceName,
        }),
      );
    } catch (error) {
      handleWorkspaceServiceRouteError(response, error);
    }
  });
}
