import { Router } from "express";
import { readCodexQuota } from "../app-server/codex-quota";

export function createCodexQuotaRouter(): Router {
  const router = Router();
  router.get("/", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.query.refresh !== undefined && request.query.refresh !== "1") {
      response.status(400).json({ message: "Invalid refresh query" });
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once("close", cancel);
    try {
      const snapshot = await readCodexQuota(request.query.refresh === "1",
        AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]));
      if (!controller.signal.aborted) response.json(snapshot);
    } finally {
      response.off("close", cancel);
    }
  });
  return router;
}
