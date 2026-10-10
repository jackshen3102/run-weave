import {
  MAX_REPORT_BYTES,
  feishuReportSchema,
} from "../runtime-status/feishu-report";
import { serviceManagementSnapshot } from "@runweave/shared/service-management";
import { Router } from "express";
import { type RuntimeStatusReport } from "@runweave/shared/runtime-status";
import type { RuntimeStatusRegistry } from "../runtime-status/registry";

export function createRuntimeStatusRouter(
  registry: RuntimeStatusRegistry,
): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(serviceManagementSnapshot(await registry.getSnapshot()));
    } catch (error) {
      next(error);
    }
  });

  router.put("/reports/feishu-bridge", (req, res) => {
    let bodySize = MAX_REPORT_BYTES + 1;
    try {
      bodySize = Buffer.byteLength(JSON.stringify(req.body), "utf8");
    } catch {
      // Schema validation below returns the stable client error.
    }
    if (bodySize > MAX_REPORT_BYTES) {
      res.status(413).json({ message: "Runtime status report is too large" });
      return;
    }
    const parsed = feishuReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid runtime status report",
        errors: parsed.error.flatten(),
      });
      return;
    }
    registry.setExternalReport(parsed.data as RuntimeStatusReport);
    res.status(204).end();
  });

  return router;
}
