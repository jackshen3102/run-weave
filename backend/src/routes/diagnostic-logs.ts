import { readFile } from "node:fs/promises";
import { Router } from "express";
import type {
  DiagnosticLogRecord,
  DiagnosticLogStopRequest,
} from "@browser-viewer/shared";
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
    res.json({ status: recorder.getStatus() });
  });

  router.post("/start", (_req, res) => {
    recorder.start();
    aiDiagnosticLog("diagnostic recording started", { trigger: "http" });
    res.json({ status: recorder.getStatus() });
  });

  router.post("/stop", (req, res) => {
    const frontendLogs = parseFrontendLogs(req.body);
    aiDiagnosticLog("diagnostic recording stopping", {
      frontendLogCount: frontendLogs.length,
      trigger: "http",
    });
    const result = recorder.stop(frontendLogs);
    res.json(result);
  });

  router.get("/result", (_req, res) => {
    res.json(recorder.getResult());
  });

  router.post("/download", async (_req, res, next) => {
    try {
      await recorder.exportLatestResult();
      const result = recorder.getResult();
      const logsJsonl = result?.files?.logsJsonl;
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
