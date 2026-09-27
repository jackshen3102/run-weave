import type { DurationMeasurement } from "@runweave/shared/execution-efficiency";

export interface TimedInterval {
  startMs: number;
  endMs: number;
}

export function measureCallIntervals(
  intervals: TimedInterval[],
): DurationMeasurement | null {
  const seconds = intervalUnionMs(intervals) / 1_000;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return {
    kind: "call-interval",
    seconds,
    targetSeconds: null,
    sampleCount: intervals.length,
    boundary: "匹配调用与返回时间戳区间的并集；不自动拆分调度、人工等待和工具执行",
    intervalCount: intervals.length,
    percentile95Seconds: null,
  };
}

export function measureStructuredElapsed(
  value: unknown,
  targetSeconds: number | null,
): DurationMeasurement | null {
  const text = extractText(value);
  const shellReady = /(?:"shellReady"\s*:\s*true|\bshellReady\s*[:=]\s*true)/iu.test(
    text,
  );
  const match = /(?:"elapsed"\s*:\s*|\belapsed\s*[:=]?\s*)(\d+(?:\.\d+)?)/iu.exec(
    text,
  );
  if (!match || !shellReady) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return {
    kind: "elapsed",
    seconds,
    targetSeconds,
    sampleCount: 1,
    boundary: "结构化工具结果 elapsed 到 shellReady=true",
    intervalCount: 1,
    percentile95Seconds: null,
  };
}

export function intervalUnionMs(intervals: TimedInterval[]): number {
  const sorted = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.startMs) &&
        Number.isFinite(interval.endMs) &&
        interval.endMs >= interval.startMs,
    )
    .sort((left, right) => left.startMs - right.startMs);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const interval of sorted) {
    if (start === null || end === null) {
      start = interval.startMs;
      end = interval.endMs;
      continue;
    }
    if (interval.startMs <= end) {
      end = Math.max(end, interval.endMs);
      continue;
    }
    total += end - start;
    start = interval.startMs;
    end = interval.endMs;
  }
  return total + (start === null || end === null ? 0 : end - start);
}

function extractText(value: unknown, depth = 0): string {
  if (depth > 12 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    try {
      return extractText(JSON.parse(value), depth + 1) || value;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value))
    return value.map((item) => extractText(item, depth + 1)).join("\n");
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ["output", "text", "value", "result"]) {
    if (key in record) return extractText(record[key], depth + 1);
  }
  return JSON.stringify(value);
}
