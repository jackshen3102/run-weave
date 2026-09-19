import { Router } from "express";
import type { TerminalSnapshotShareErrorResponse } from "@runweave/shared/terminal/snapshot-share";
import type { TerminalSnapshotShareService } from "../../terminal/snapshot-share/service";
import { TerminalSnapshotShareError } from "../../terminal/snapshot-share/errors";

export function createTerminalSnapshotShareRouter(service: TerminalSnapshotShareService): Router {
  const router = Router();
  router.post("/session/:sessionId/panels/:panelId/shares", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const result = await service.create(String(req.params.sessionId), String(req.params.panelId));
      res.status(201).json(result);
    } catch (error) {
      const failure = error instanceof TerminalSnapshotShareError ? error
        : new TerminalSnapshotShareError("SNAPSHOT_STORAGE_FAILED");
      const body: TerminalSnapshotShareErrorResponse = { message: failure.message, code: failure.code };
      res.status(failure.status).json(body);
    }
  });
  return router;
}
