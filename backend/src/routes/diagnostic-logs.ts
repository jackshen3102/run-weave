import { readFile } from "node:fs/promises";
import { Router } from "express";
import type { DiagnosticLogRecord, DiagnosticLogStopRequest } from "@runweave/shared/diagnostic-logs";
import {
  DiagnosticLogRecorder,
  createAiDiagnosticLog,
} from "../diagnostic-logs/recorder";

interface DiagnosticLogsRouterOptions {
  consoleLog?: (message: string, details?: Record<string, unknown>) => void;
}

function parseFrontendLogs(body: unknown): DiagnosticLogRecord[] {
  const payload = body as DiagnosticLogStopRequest | undefined;
  return Array.isArray(payload?.frontendLogs) ? payload.frontendLogs : [];
}

export function createDiagnosticLogsRouter(
  recorder: DiagnosticLogRecorder,
  options: DiagnosticLogsRouterOptions = {},
): Router {
  const router = Router();
  const aiDiagnosticLog = createAiDiagnosticLog({
    recorder,
    source: "backend",
    consoleLog: options.consoleLog,
  });

  router.get("/status", (_req, res) => {
    res.json({
      status: recorder.getStatus(),
      startedAt: recorder.getStartedAt(),
    });
  });

  router.post("/start", (_req, res) => {
    recorder.start();
    aiDiagnosticLog("diagnostic recording started", { trigger: "http" });
    res.json({
      status: recorder.getStatus(),
      startedAt: recorder.getStartedAt(),
    });
  });

  router.post("/stop", async (req, res, next) => {
    const frontendLogs = parseFrontendLogs(req.body);
    aiDiagnosticLog("diagnostic recording stopping", {
      frontendLogCount: frontendLogs.length,
      trigger: "http",
    });
    recorder.stop(frontendLogs);
    try {
      // Persist on stop so both client and server logs land in a stable,
      // discoverable server-side directory for analysis.
      await recorder.persistLatestResult();
      res.json(recorder.getResult());
    } catch (error) {
      next(error);
    }
  });

  router.get("/result", (_req, res) => {
    res.json(recorder.getResult());
  });

  router.post("/download", async (_req, res, next) => {
    try {
      const existing = recorder.getResult();
      const logsJsonl =
        existing?.files?.logsJsonl ??
        (await recorder.persistLatestResult()).logsJsonl;
      if (!logsJsonl) {
        res.status(404).json({ message: "Diagnostic log result not found" });
        return;
      }

      res.setHeader("Content-Type", "application/jsonl; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="diagnostic-logs.jsonl"',
      );
      res.send(await readFile(logsJsonl, "utf8"));
    } catch (error) {
      if (error instanceof Error && error.message.includes("No diagnostic")) {
        res.status(404).json({ message: "Diagnostic log result not found" });
        return;
      }

      next(error);
    }
  });

  return router;
}
