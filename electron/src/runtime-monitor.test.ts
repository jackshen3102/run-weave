import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeStatsSnapshot,
  type ElectronProcessMetric,
} from "./runtime-monitor.js";

test("buildRuntimeStatsSnapshot aggregates electron and backend runtime stats", () => {
  const processMetrics: ElectronProcessMetric[] = [
    {
      pid: 101,
      type: "Browser",
      cpu: { percentCPUUsage: 12.5 },
      memory: { workingSetSize: 256_000 },
      creationTime: 1,
    },
    {
      pid: 202,
      type: "Tab",
      name: "Main Window",
      cpu: { percentCPUUsage: 7.25 },
      memory: { workingSetSize: 128_000 },
      creationTime: 2,
    },
  ];

  const snapshot = buildRuntimeStatsSnapshot({
    sampledAt: 1_710_000_000_000,
    processMetrics,
    backendPid: 303,
    backendUsage: {
      cpu: 3.5,
      memory: 314_572_800,
    },
  });

  assert.deepEqual(snapshot, {
    sampledAt: 1_710_000_000_000,
    electron: {
      totalCpuPercent: 19.75,
      totalMemoryMb: 375,
      processes: [
        {
          pid: 101,
          type: "Browser",
          name: null,
          serviceName: null,
          cpuPercent: 12.5,
          memoryMb: 250,
        },
        {
          pid: 202,
          type: "Tab",
          name: "Main Window",
          serviceName: null,
          cpuPercent: 7.25,
          memoryMb: 125,
        },
      ],
    },
    backend: {
      available: true,
      pid: 303,
      cpuPercent: 3.5,
      memoryMb: 300,
    },
  });
});

test("buildRuntimeStatsSnapshot marks backend unavailable when pid is absent", () => {
  const snapshot = buildRuntimeStatsSnapshot({
    sampledAt: 1,
    processMetrics: [],
    backendPid: null,
    backendUsage: null,
  });

  assert.deepEqual(snapshot.backend, {
    available: false,
    pid: null,
    cpuPercent: null,
    memoryMb: null,
  });
  assert.equal(snapshot.electron.totalCpuPercent, 0);
  assert.equal(snapshot.electron.totalMemoryMb, 0);
  assert.deepEqual(snapshot.electron.processes, []);
});
