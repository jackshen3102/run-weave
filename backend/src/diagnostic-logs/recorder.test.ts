import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiagnosticLogRecorder,
  createAiDiagnosticLog,
} from "./recorder";

describe("DiagnosticLogRecorder", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  async function createTempRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runweave-diagnostic-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("collects only AI diagnostic logs inside an active recording window", () => {
    const recorder = new DiagnosticLogRecorder();
    const consoleLog = vi.fn();
    const aiDiagnosticLog = createAiDiagnosticLog({
      recorder,
      source: "backend",
      consoleLog,
    });

    aiDiagnosticLog("outside window", { step: "before-start" });
    recorder.start();
    aiDiagnosticLog("inside window", { step: "recording" });
    const result = recorder.stop();
    aiDiagnosticLog("after stop", { step: "ended" });

    expect(consoleLog).toHaveBeenCalledTimes(3);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({
      source: "backend",
      message: "inside window",
      details: { step: "recording" },
    });
    expect(recorder.getResult()?.logs).toHaveLength(1);
  });

  it("restarts with an empty buffer when start is called during recording", () => {
    const recorder = new DiagnosticLogRecorder();

    recorder.start();
    recorder.append({
      at: "2026-04-20T10:00:00.000Z",
      source: "backend",
      message: "old",
    });
    recorder.start();
    recorder.append({
      at: "2026-04-20T10:00:01.000Z",
      source: "backend",
      message: "new",
    });

    expect(recorder.stop().logs.map((log) => log.message)).toEqual(["new"]);
  });

  it("merges frontend logs, sorts by time, and redacts sensitive output", () => {
    const recorder = new DiagnosticLogRecorder();
    recorder.start();
    recorder.append({
      at: "2026-04-20T10:00:02.000Z",
      source: "backend",
      message:
        "Authorization: Bearer backend-token Cookie: sid=abc request https://example.test/?token=secret&ok=1",
      details: {
        password: "hunter2",
        nested: {
          apiKey: "key-123",
          url: "https://example.test/path?access_token=abc&safe=yes",
        },
      },
    });

    const result = recorder.stop([
      {
        at: "2026-04-20T10:00:01.000Z",
        source: "frontend",
        message: "Cookie: frontend=secret",
        details: {
          step: "submit",
        },
      },
    ]);

    expect(result.logs.map((log) => log.source)).toEqual([
      "frontend",
      "backend",
    ]);
    expect(JSON.stringify(result.logs)).not.toContain("backend-token");
    expect(JSON.stringify(result.logs)).not.toContain("hunter2");
    expect(JSON.stringify(result.logs)).not.toContain("key-123");
    expect(JSON.stringify(result.logs)).not.toContain("frontend=secret");
    expect(result.redactionReport).toEqual({
      authorizationHeaders: 1,
      cookies: 2,
      tokens: 4,
    });
  });

  it("writes a jsonl export and removes it when a new recording starts", async () => {
    const tempRoot = await createTempRoot();
    const recorder = new DiagnosticLogRecorder({ tempRoot });
    recorder.start();
    recorder.append({
      at: "2026-04-20T10:00:00.000Z",
      source: "backend",
      message: "export me",
    });
    recorder.stop();

    const exportResult = await recorder.exportLatestResult();

    expect(exportResult.logsJsonl).toContain("diagnostic-logs-");
    expect(exportResult.redactionReportJson).toContain("redaction-report.json");
    expect(recorder.getResult()?.files).toEqual(exportResult);

    if (!exportResult.logsJsonl) {
      throw new Error("Expected logsJsonl export path");
    }

    await expect(access(exportResult.logsJsonl)).resolves.toBeUndefined();

    recorder.start();

    expect(recorder.getResult()).toBeNull();
    await expect(access(exportResult.logsJsonl)).rejects.toThrow();
  });
});
