import { describe, expect, it, vi } from "vitest";
import {
  FrontendDiagnosticLogRecorder,
  createAiDiagnosticLog,
  formatDiagnosticLogResult,
} from "./recorder";

describe("FrontendDiagnosticLogRecorder", () => {
  it("collects only AI diagnostic logs while recording and still prints all calls", () => {
    const recorder = new FrontendDiagnosticLogRecorder();
    const consoleLog = vi.fn();
    const aiDiagnosticLog = createAiDiagnosticLog({
      recorder,
      source: "frontend",
      consoleLog,
    });

    aiDiagnosticLog("outside", { step: "before-start" });
    recorder.start();
    aiDiagnosticLog("inside", { step: "recording" });
    recorder.finish({
      startedAt: "2026-04-20T10:00:00.000Z",
      stoppedAt: "2026-04-20T10:00:01.000Z",
      logs: [],
    });
    aiDiagnosticLog("after", { step: "ended" });

    expect(consoleLog).toHaveBeenCalledTimes(3);
    expect(recorder.getBufferedLogs()).toHaveLength(0);
    expect(recorder.getResult()?.logs).toEqual([]);
  });

  it("clears previous logs and result when starting a new recording", () => {
    const recorder = new FrontendDiagnosticLogRecorder();

    recorder.start();
    recorder.append({
      at: "2026-04-20T10:00:00.000Z",
      source: "frontend",
      message: "old",
    });
    recorder.finish({
      startedAt: "2026-04-20T10:00:00.000Z",
      stoppedAt: "2026-04-20T10:00:01.000Z",
      logs: [
        {
          at: "2026-04-20T10:00:00.000Z",
          source: "frontend",
          message: "old",
        },
      ],
    });

    recorder.start();

    expect(recorder.getStatus()).toBe("recording");
    expect(recorder.getBufferedLogs()).toEqual([]);
    expect(recorder.getResult()).toBeNull();
  });

  it("formats results as copyable log text", () => {
    expect(
      formatDiagnosticLogResult({
        startedAt: "2026-04-20T09:59:58.000Z",
        stoppedAt: "2026-04-20T10:00:02.000Z",
        logs: [
          {
            at: "2026-04-20T10:00:00.000Z",
            source: "frontend",
            message: "before request",
            details: { step: "submit" },
          },
        ],
      }),
    ).toContain(
      '2026-04-20T10:00:00.000Z [frontend] before request {"step":"submit"}',
    );
  });
});
