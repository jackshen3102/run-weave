import type {
  EfficiencyDimension,
  EfficiencyMeasurement,
} from "@runweave/shared/execution-efficiency";

export const EXECUTION_EFFICIENCY_POLICY_VERSION = "2026-09-26.v1";

export interface ScreeningResult {
  admitted: boolean;
  reason: string;
}

export function screenMeasurement(
  dimension: EfficiencyDimension,
  measurement: EfficiencyMeasurement,
): ScreeningResult {
  if (dimension === "duration" && measurement.kind !== "token-windows") {
    if (
      measurement.targetSeconds !== null &&
      measurement.seconds !== null &&
      measurement.seconds > measurement.targetSeconds
    ) {
      return {
        admitted: true,
        reason: `观测耗时 ${measurement.seconds.toFixed(3)} 秒超过明确目标 ${measurement.targetSeconds} 秒`,
      };
    }
    if (
      measurement.sampleCount >= 3 &&
      measurement.seconds !== null &&
      measurement.seconds >= 30
    ) {
      return {
        admitted: true,
        reason: `同类行为重复 ${measurement.sampleCount} 次，相关时间并集 ${measurement.seconds.toFixed(3)} 秒`,
      };
    }
    return { admitted: false, reason: "耗时测量未达到首版保守阈值" };
  }
  if (dimension === "tokens" && measurement.kind === "token-windows") {
    const enoughOccurrences = measurement.occurrences >= 3;
    const enoughNonCached = (measurement.nonCachedInput ?? 0) >= 10_000;
    const enoughCached = (measurement.cachedInput ?? 0) >= 500_000;
    if (enoughOccurrences && (enoughNonCached || enoughCached)) {
      return {
        admitted: true,
        reason: `同类行为重复 ${measurement.occurrences} 次，相关区间非缓存输入 ${measurement.nonCachedInput ?? "未知"}、缓存输入 ${measurement.cachedInput ?? "未知"}`,
      };
    }
    return { admitted: false, reason: "Token 测量未达到首版保守阈值" };
  }
  return { admitted: false, reason: "测量方向与类型不一致" };
}
