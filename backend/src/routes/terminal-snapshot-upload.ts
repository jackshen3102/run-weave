import { createHash, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import type { PublishTerminalSnapshotRequest } from "@runweave/shared/terminal/snapshot-share";
import type { TerminalSnapshotHostService } from "../terminal/snapshot-share/host-service";
import { TerminalSnapshotShareError } from "../terminal/snapshot-share/errors";
import { SNAPSHOT_MAX_TEXT_BYTES } from "../terminal/snapshot-share/store";

const uploadSchema: z.ZodType<PublishTerminalSnapshotRequest> = z.object({
  title: z.string().max(240),
  text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_TEXT_BYTES),
}).strict();

export function createTerminalSnapshotUploadRouter(service: TerminalSnapshotHostService, token: string): Router {
  const router = Router();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  let activeRequests = 0;
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const supplied = createHash("sha256").update(req.get("Authorization") ?? "").digest();
    if (!timingSafeEqual(supplied, expected)) {
      res.status(401).json({ message: "Invalid upload credential" });
      return;
    }
    if (activeRequests >= 4) {
      res.status(429).json({ code: "SNAPSHOT_BUSY" });
      return;
    }
    activeRequests += 1;
    res.once("close", () => { activeRequests -= 1; });
    next();
  });
  // Authenticate and limit concurrency before accepting or parsing a potentially large body.
  router.post("/", express.json({ limit: SNAPSHOT_MAX_TEXT_BYTES * 6 + 4096, inflate: false }), async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      const oversized = typeof req.body?.text === "string" && Buffer.byteLength(req.body.text, "utf8") > SNAPSHOT_MAX_TEXT_BYTES;
      res.status(oversized ? 413 : 400).json({ message: "Invalid snapshot payload" });
      return;
    }
    try {
      res.status(201).json(await service.save(parsed.data.title, parsed.data.text));
    } catch (error) {
      const failure = error instanceof TerminalSnapshotShareError ? error : new TerminalSnapshotShareError("SNAPSHOT_STORAGE_FAILED");
      res.status(failure.status).json({ code: failure.code, message: failure.message });
    }
  });
  router.use((_req, res) => { res.set("Allow", "POST").status(405).end(); });
  return router;
}
