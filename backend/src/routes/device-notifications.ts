import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import {
  DeviceSubscriptions,
  SubscriptionError,
} from "../device-monitor/subscriptions";
const registration = z
  .object({
    connectionId: z.string().min(1).max(256),
    deviceToken: z.string().regex(/^(?:[0-9a-f]{2}){1,2048}$/),
    environment: z.enum(["sandbox", "production"]),
    displayName: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    explicitEnable: z.boolean().optional(),
  })
  .strict();
export function createDeviceNotificationsRouter(
  service: DeviceSubscriptions | null,
  auth: AuthService,
): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 8192) {
      res.status(413).json({ message: "Request too large" });
      return;
    }
    next();
  });
  router.all(
    [
      "/status",
      "/subscriptions/:installationId",
      "/subscriptions/:installationId/confirm",
    ],
    async (req, res) => {
      try {
        const identity = auth.verifyAccessToken(readBearerToken(req) ?? "");
        if (!identity) throw new SubscriptionError(401, "Unauthorized");
        if (!service) {
          if (req.method === "GET") {
            res.json({
              available: false,
              reason: "电量监控暂不可用",
              subscriptions: [],
            });
            return;
          }
          throw new SubscriptionError(503, "提醒暂不可用");
        }
        if (req.method === "GET" && req.path === "/status") {
          res.json(service.status(identity.sessionId));
          return;
        }
        const id = req.params.installationId;
        if (!z.string().uuid().safeParse(id).success)
          throw new SubscriptionError(400, "Invalid installationId");
        if (req.method === "POST" && req.path.endsWith("/confirm")) {
          const body = z
            .object({
              subscriptionId: z.string().uuid(),
              version: z.number().int().positive(),
            })
            .strict()
            .safeParse(req.body);
          if (!body.success)
            throw new SubscriptionError(400, "Invalid confirmation");
          res.json(
            await service.confirm(
              identity.sessionId,
              String(id),
              body.data.subscriptionId,
              body.data.version,
            ),
          );
          return;
        }
        if (req.method === "PUT") {
          const input = registration.safeParse(req.body);
          if (!input.success)
            throw new SubscriptionError(400, "Invalid registration");
          res.json(
            await service.register(identity.sessionId, String(id), input.data),
          );
          return;
        }
        if (req.method === "DELETE") {
          const confirmed = await service.revoke(
            identity.sessionId,
            String(id),
          );
          if (!confirmed)
            throw new SubscriptionError(503, "远端提醒关闭尚未确认");
          res.sendStatus(204);
          return;
        }
        res.sendStatus(405);
      } catch (error) {
        res
          .status(error instanceof SubscriptionError ? error.status : 503)
          .json({
            message:
              error instanceof SubscriptionError
                ? error.message
                : "推送暂不可用",
          });
      }
    },
  );
  return router;
}
