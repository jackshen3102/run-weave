import os from "node:os";
import type { SystemMonitorSnapshot } from "@runweave/shared/system-monitor";
interface Counter {
  started: string;
  cpu: bigint;
  wakeups: bigint;
}
interface Frame {
  clock: bigint;
  factor: number;
  counters: Map<number, Counter>;
  truncated: boolean;
}
function parse(output: string): Frame {
  const lines = output.trim().split("\n");
  const clock = lines[0]?.split("\t");
  const coverage = lines[1]?.split("\t");
  if (
    clock?.[0] !== "clock" ||
    coverage?.[0] !== "coverage" ||
    !/^\d+$/.test(clock[1] ?? "")
  )
    throw new Error("无效的进程计数器输出");
  const factor = Number(clock[2]) / Number(clock[3]);
  if (!(factor > 0) || !Number.isFinite(factor))
    throw new Error("无效的系统时间换算");
  const counters = new Map<number, Counter>();
  for (const line of lines.slice(2)) {
    const fields = line.split("\t");
    if (fields.length !== 5 || fields.some((value) => !/^\d+$/.test(value)))
      throw new Error("无效的进程计数器");
    counters.set(Number(fields[0]), {
      started: fields[1]!,
      cpu: BigInt(fields[2]!) + BigInt(fields[3]!),
      wakeups: BigInt(fields[4]!),
    });
  }
  return {
    clock: BigInt(clock[1]!),
    factor,
    counters,
    truncated: Number(coverage[1]) > 4096 || Number(coverage[2]) >= 4096,
  };
}
export class ResourceCounters {
  private previous: Frame | null = null;
  private previousCpu: { busy: number; total: number } | null = null;
  read(output: string): {
    scores: Map<number, { cpu: number; power: number }>;
    truncated: boolean;
    cpu: SystemMonitorSnapshot["cpu"];
  } {
    const frame = parse(output);
    const previous = this.previous;
    const elapsedNs = previous
      ? Number(frame.clock - previous.clock) * frame.factor
      : 0;
    const scores = new Map<number, { cpu: number; power: number }>();
    if (
      previous &&
      elapsedNs > 0 &&
      elapsedNs <= 90_000_000_000 &&
      frame.factor === previous.factor
    ) {
      for (const [pid, counter] of frame.counters) {
        const before = previous.counters.get(pid);
        if (
          !before ||
          before.started !== counter.started ||
          before.cpu > counter.cpu ||
          before.wakeups > counter.wakeups
        )
          continue;
        const cpuNs = Number(counter.cpu - before.cpu) * frame.factor;
        const wakeups = Number(counter.wakeups - before.wakeups);
        // Relative cost proxy: CPU plus 0.5ms per package idle wakeup. Never watts.
        scores.set(pid, {
          cpu: Math.round((cpuNs / elapsedNs) * 1000) / 10,
          power:
            Math.round(((cpuNs + wakeups * 500_000) / elapsedNs) * 1000) / 10,
        });
      }
    }
    this.previous = frame;
    const cpus = os.cpus();
    const times = cpus.reduce(
      (sum, cpu) => {
        const busy =
          cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
        return {
          busy: sum.busy + busy,
          total: sum.total + busy + cpu.times.idle,
        };
      },
      { busy: 0, total: 0 },
    );
    const prevCpu = this.previousCpu;
    const totalDelta = prevCpu ? times.total - prevCpu.total : 0;
    this.previousCpu = times;
    return {
      scores,
      truncated: frame.truncated,
      cpu: {
        totalPercent:
          prevCpu &&
          totalDelta > 0 &&
          elapsedNs > 0 &&
          elapsedNs <= 90_000_000_000
            ? Math.round(((times.busy - prevCpu.busy) / totalDelta) * 1000) / 10
            : null,
        coreCount: cpus.length,
        warmingUp: !prevCpu || elapsedNs > 90_000_000_000,
      },
    };
  }
}
