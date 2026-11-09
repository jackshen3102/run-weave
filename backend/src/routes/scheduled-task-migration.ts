import type { Router, RequestHandler } from "express";
import { z } from "zod";
import { SCHEDULED_TASK_PROMPT_MAX_LENGTH } from "@runweave/shared/scheduled-tasks";
import type { ScheduledTaskService } from "../scheduled-tasks/service";
import { ScheduledTaskError } from "../scheduled-tasks/errors";

export const taskContextVersionGate: RequestHandler = (req, res, next) => {
  if (["POST", "PATCH", "DELETE"].includes(req.method) && req.header("X-Runweave-Task-Context-Version") !== "2") {
    res.status(409).json({ code: "task_context_version_mismatch", message: "定时任务协议已更新，请更新客户端后操作。" });
    return;
  }
  next();
};

const applySchema = z.object({
  expectedDatabaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tasks: z.array(z.object({ id: z.string().min(1), expectedRevision: z.number().int().positive(), prompt: z.string().min(1).max(SCHEDULED_TASK_PROMPT_MAX_LENGTH) }).strict()),
}).strict();

export function registerScheduledTaskMigrationRoutes(router: Router, service: ScheduledTaskService): void {
  for (const operation of ["preview", "apply"] as const) {
    router.post(`/migration/${operation}`, async (req, res) => {
      try {
        if (!service.migration) throw new ScheduledTaskError("scheduler_unavailable", 503, "任务迁移入口不可用。");
        if (operation === "preview") {
          z.object({}).strict().parse(req.body);
          res.json(service.migration.preview());
        } else {
          const key = req.header("Idempotency-Key");
          if (!key?.trim() || key.length > 200) throw new ScheduledTaskError("invalid_input", 400, "Idempotency-Key is required");
          res.json(await service.migration.apply(applySchema.parse(req.body), key));
        }
      } catch (error) {
        if (error instanceof z.ZodError) res.status(400).json({ code: "invalid_input", message: "迁移草稿格式无效。" });
        else if (error instanceof ScheduledTaskError) res.status(error.statusCode).json({ code: error.code, message: error.message });
        else res.status(503).json({ code: "migration_failed", message: "迁移未确认成功；旧任务未启用，请保留原请求并核对数据库和备份。" });
      }
    });
  }
}
