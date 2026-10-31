import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { configuration } from "@runweave/config-node";
import { isLocalDirectHttpRequest } from "../server/local-request";
import { ServerMaintenance } from "../scheduled-tasks/server-maintenance";
import type { ScheduledTaskRuntime } from "../scheduled-tasks/runtime";
import type { RuntimeStatusRegistry } from "../runtime-status/registry";

export function createServerManagementRouter(
  runtime?: ScheduledTaskRuntime | null,
  registry?: RuntimeStatusRegistry,
): Router {
  const router = Router();
  const maintenance =
    runtime?.maintenance ??
    new ServerMaintenance(
      async () => {},
      () => [],
      () => {},
    );
  router.use((req, res, next) => {
    if (!isLocalDirectHttpRequest(req)) {
      res.sendStatus(403);
      return;
    }
    try {
      const file = path.join(
        configuration().context.configRoot,
        "server",
        "management-token",
      );
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.mode & 0o077 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error("Invalid management token file");
      const expected = Buffer.from(readFileSync(file, "utf8").trim());
      const actual = Buffer.from(req.header("x-runweave-server-token") ?? "");
      if (
        !expected.length ||
        actual.length !== expected.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error("Invalid token");
      if (
        !/^[a-zA-Z0-9-]{16,128}$/.test(
          req.header("x-runweave-server-owner") ?? "",
        )
      )
        throw new Error("Invalid owner");
      next();
    } catch {
      res.sendStatus(403);
    }
  });
  router.get("/status", async (_req, res, next) => {
    try {
      res.json((await registry?.getSnapshot()) ?? null);
    } catch (error) {
      next(error);
    }
  });
  router.post("/maintenance", async (req, res) => {
    try {
      res.json(
        await maintenance.acquire(req.header("x-runweave-server-owner")!),
      );
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  router.post("/maintenance/:id/renew", (req, res) => {
    try {
      res.json(
        maintenance.renew(
          req.header("x-runweave-server-owner")!,
          req.params.id!,
        ),
      );
    } catch {
      res.status(409).json({ error: "MAINTENANCE_LEASE_INVALID" });
    }
  });
  router.delete("/maintenance/:id", (req, res) => {
    try {
      maintenance.release(
        req.header("x-runweave-server-owner")!,
        req.params.id!,
      );
      res.sendStatus(204);
    } catch {
      res.status(409).json({ error: "MAINTENANCE_LEASE_INVALID" });
    }
  });
  return router;
}
