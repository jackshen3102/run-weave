import { Router } from "express";
import { z } from "zod";
import {
  RUNTIME_STATUS_CAPABILITY_IDS,
  RUNTIME_STATUS_STATES,
  type RuntimeStatusReport,
} from "@runweave/shared/runtime-status";
import type { RuntimeStatusRegistry } from "../runtime-status/registry";

const MAX_REPORT_BYTES = 64 * 1024;
const id = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);
const displayText = z.string().trim().min(1).max(512);
const timestamp = z.number().int().nonnegative().finite();

const recoverySchema = z
  .object({
    startedAt: timestamp,
    attempt: z.number().int().nonnegative().nullable(),
    maxAttempts: z.number().int().positive().nullable(),
    nextAttemptAt: timestamp.nullable(),
    deadlineAt: timestamp.nullable(),
  })
  .strict();

const factSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(128),
    value: z.string().trim().min(1).max(2_048),
    kind: z.enum(["address", "port", "text", "time"]),
    copyable: z.boolean(),
  })
  .strict();

const navigationSchema = z
  .object({
    label: z.string().trim().min(1).max(128),
    route: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .regex(/^\/(?!\/)[^\s\\]*$/u, "route must be an application path"),
  })
  .strict();

const itemSchema = z
  .object({
    id,
    capabilityId: z.enum(RUNTIME_STATUS_CAPABILITY_IDS),
    label: z.string().trim().min(1).max(128),
    state: z.enum(RUNTIME_STATUS_STATES),
    summary: displayText,
    observedAt: timestamp,
    dependsOn: z.array(id).max(32),
    recovery: recoverySchema.nullable(),
    facts: z.array(factSchema).max(16),
    navigation: navigationSchema.nullable(),
  })
  .strict();

const feishuReportSchema = z
  .object({
    protocolVersion: z.literal(1),
    target: z.union([
      z.object({ kind: z.literal("local-host") }).strict(),
      z.object({ kind: z.literal("node"), nodeId: id }).strict(),
    ]),
    source: z
      .object({
        id: z.literal("feishu-bridge"),
        runtime: z.literal("feishu-bridge"),
        instanceId: id,
        capabilityId: z.literal("feishu"),
      })
      .strict(),
    observedAt: timestamp,
    validForMs: z
      .number()
      .int()
      .min(10)
      .max(5 * 60_000),
    items: z.array(itemSchema).max(32),
  })
  .strict()
  .superRefine((report, context) => {
    for (const [index, item] of report.items.entries()) {
      if (item.capabilityId !== "feishu" || !item.id.startsWith("feishu.")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index],
          message: "Feishu reports may only contain feishu.* items",
        });
      }
    }
  });

export function createRuntimeStatusRouter(
  registry: RuntimeStatusRegistry,
): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await registry.getSnapshot());
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
