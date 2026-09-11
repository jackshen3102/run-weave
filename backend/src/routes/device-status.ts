import { Router } from "express";
import type { DeviceMonitorService } from "../device-monitor/service";

export function createDeviceStatusRouter(
  service: DeviceMonitorService | null,
): Router {
  const router = Router();
  router.get("/status", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!service) {
      res.status(503).json({ message: "电量监控暂不可用" });
      return;
    }
    res.json(service.snapshot());
  });
  return router;
}
