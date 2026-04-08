import { describe, expect, it } from "vitest";
import type { RuntimeStatsSnapshot } from "@browser-viewer/shared";
import { formatRuntimeSummary } from "./electron.runtime-monitor-format";

const snapshot: RuntimeStatsSnapshot = {
  sampledAt: 1,
  electron: {
    totalCpuPercent: 19.75,
    totalMemoryMb: 375,
    processes: [],
  },
  backend: {
    available: true,
    pid: 303,
    cpuPercent: 3.5,
    memoryMb: 300,
  },
};

describe("formatRuntimeSummary", () => {
  it("formats combined electron and backend resource usage", () => {
    expect(formatRuntimeSummary(snapshot)).toBe("CPU 23.25% · RAM 675 MB");
  });

  it("falls back to electron-only totals when backend stats are unavailable", () => {
    expect(
      formatRuntimeSummary({
        ...snapshot,
        backend: {
          available: false,
          pid: null,
          cpuPercent: null,
          memoryMb: null,
        },
      }),
    ).toBe("CPU 19.75% · RAM 375 MB");
  });

  it("returns a placeholder while stats are loading", () => {
    expect(formatRuntimeSummary(null)).toBe("CPU -- · RAM --");
  });
});
