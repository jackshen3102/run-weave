import type { RuntimeStatsSnapshot } from "@browser-viewer/shared";

function formatCpu(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

export function formatRuntimeSummary(
  snapshot: RuntimeStatsSnapshot | null,
): string {
  if (!snapshot) {
    return "CPU -- · RAM --";
  }

  const totalCpu =
    snapshot.electron.totalCpuPercent + (snapshot.backend.cpuPercent ?? 0);
  const totalMemory =
    snapshot.electron.totalMemoryMb + (snapshot.backend.memoryMb ?? 0);

  return `CPU ${formatCpu(totalCpu)} · RAM ${totalMemory} MB`;
}
