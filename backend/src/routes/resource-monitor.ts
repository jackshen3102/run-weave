import { Router } from "express";
import { z } from "zod";
import { readBearerToken } from "../auth/middleware";
import type { AuthService } from "../auth/service";
import { isLocalDirectHttpRequest } from "../server/local-request";
import type { ResourceMonitorService } from "../resource-monitor/service";
import { ResourceRequestError } from "../resource-monitor/process-actions";

const settingsSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    monitorEnabled: z.boolean(),
    alertsEnabled: z.boolean(),
  })
  .strict();
const terminateSchema = z
  .object({ requestId: z.string().uuid(), force: z.boolean() })
  .strict();
const snoozeSchema = z.object({ durationMinutes: z.literal(60) }).strict();
export function createResourceMonitorRouter(
  service: ResourceMonitorService | null,
  auth: AuthService,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!service) {
      res.status(503).json({ message: "资源监控暂不可用" });
      return;
    }
    next();
  });
  router.get("/", (req, res) =>
    res.json(service!.snapshot(isLocalDirectHttpRequest(req))),
  );
  router.get("/settings", (_req, res) =>
    res.json(service!.store.snapshot().settings),
  );
  router.put("/settings", async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "无效的提醒设置" });
      return;
    }
    try {
      res.json(
        await service!.settings({
          revision: parsed.data.expectedRevision,
          monitorEnabled: parsed.data.monitorEnabled,
          alertsEnabled: parsed.data.alertsEnabled,
        }),
      );
    } catch (error) {
      respond(error, res);
    }
  });
  router.post("/alerts/:alertId/snooze", async (req, res) => {
    if (!snoozeSchema.safeParse(req.body).success) {
      res.status(400).json({ message: "只支持忽略 1 小时" });
      return;
    }
    try {
      await service!.snooze(req.params.alertId);
      res.json({ ok: true });
    } catch (error) {
      respond(error, res);
    }
  });
  router.post("/processes/:processInstanceId/terminate", async (req, res) => {
    if (!isLocalDirectHttpRequest(req)) {
      res.status(403).json({
        code: "local_request_required",
        message: "仅本机直连可结束进程",
      });
      return;
    }
    const parsed = terminateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "无效的进程操作" });
      return;
    }
    const token = readBearerToken(req)!;
    const session = auth.verifyAccessToken(token)?.sessionId;
    if (!session) {
      res.status(401).json({ message: "会话已失效" });
      return;
    }
    try {
      res.json(
        await service!.terminate(
          req.params.processInstanceId,
          parsed.data,
          session,
          () => !!auth.verifyAccessToken(token),
        ),
      );
    } catch (error) {
      respond(error, res);
    }
  });
  return router;
}
function respond(error: unknown, res: import("express").Response): void {
  if (error instanceof ResourceRequestError)
    res.status(error.status).json({ code: error.code, message: error.message });
  else res.status(503).json({ message: "资源监控操作失败，请稍后重试" });
}
