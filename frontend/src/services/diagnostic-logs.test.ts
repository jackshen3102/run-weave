import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticLogRecord } from "@browser-viewer/shared";
import {
  downloadDiagnosticLogs,
  getDiagnosticLogResult,
  getDiagnosticLogStatus,
  startDiagnosticLogs,
  stopDiagnosticLogs,
} from "./diagnostic-logs";

describe("diagnostic log service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts recording with the bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "recording" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await startDiagnosticLogs("http://localhost:5001", "token-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/diagnostic-logs/start",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("stops recording with buffered frontend logs", async () => {
    const frontendLogs: DiagnosticLogRecord[] = [
      {
        at: "2026-04-20T10:00:00.000Z",
        source: "frontend",
        message: "before request",
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        startedAt: "2026-04-20T09:59:58.000Z",
        stoppedAt: "2026-04-20T10:00:02.000Z",
        logs: frontendLogs,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await stopDiagnosticLogs("http://localhost:5001", "token-1", frontendLogs);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/diagnostic-logs/stop",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({ frontendLogs }),
      },
    );
  });

  it("reads status, result, and download endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith("/status")
          ? { status: "ready" }
          : {
              startedAt: "2026-04-20T09:59:58.000Z",
              stoppedAt: "2026-04-20T10:00:02.000Z",
              logs: [],
            },
      blob: async () => new Blob(["{}\n"], { type: "application/jsonl" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getDiagnosticLogStatus("http://localhost:5001", "token-1");
    await getDiagnosticLogResult("http://localhost:5001", "token-1");
    await downloadDiagnosticLogs("http://localhost:5001", "token-1");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://localhost:5001/api/diagnostic-logs/download",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });
});
