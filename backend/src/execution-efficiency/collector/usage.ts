import type {
  TokenMeasurement,
  TokenUsageCounts,
  TokenUsageSample,
} from "@runweave/shared/execution-efficiency";

export interface RawTokenUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

export interface TokenWindow {
  beforeIndex: number;
  afterIndex: number;
  callIds: string[];
}

export function parseUsageSample(
  value: RawTokenUsage | null | undefined,
  context: {
    line: number;
    observedAt: string;
    model?: string | null;
    serviceTier?: string | null;
  },
): TokenUsageSample | null {
  if (!value) return null;
  const input = counter(value.input_tokens);
  const output = counter(value.output_tokens);
  const total = counter(value.total_tokens);
  if (input === null || output === null || total === null) return null;
  if (total !== input + output) return null;
  const cachedInput = optionalCounter(value.cached_input_tokens);
  const cacheWriteInput = optionalCounter(value.cache_write_input_tokens);
  const reasoningOutput = optionalCounter(value.reasoning_output_tokens);
  if (cachedInput !== null && cachedInput > input) return null;
  if (reasoningOutput !== null && reasoningOutput > output) return null;
  return {
    input,
    cachedInput,
    cacheWriteInput,
    output,
    reasoningOutput,
    total,
    line: context.line,
    observedAt: context.observedAt,
    model: context.model ?? null,
    serviceTier: context.serviceTier ?? null,
  };
}

export function measureTokenWindows(
  samples: TokenUsageSample[],
  windows: TokenWindow[],
  occurrences: number,
): TokenMeasurement | null {
  const merged = mergeWindows(windows).filter(
    (window) =>
      samples[window.beforeIndex] !== undefined &&
      samples[window.afterIndex] !== undefined,
  );
  if (!merged.length) return null;
  const totals = emptyCounts();
  const models = new Set<string>();
  const serviceTiers = new Set<string>();
  const callIds = new Set<string>();
  let valid = 0;
  for (const window of merged) {
    const before = samples[window.beforeIndex];
    const after = samples[window.afterIndex];
    if (!before || !after) continue;
    const delta = subtractUsage(after, before);
    if (!delta) continue;
    addCounts(totals, delta);
    valid += 1;
    window.callIds.forEach((id) => callIds.add(id));
    if (before.model) models.add(before.model);
    if (after.model) models.add(after.model);
    if (before.serviceTier) serviceTiers.add(before.serviceTier);
    if (after.serviceTier) serviceTiers.add(after.serviceTier);
  }
  if (!valid) return null;
  const nonCachedInput =
    totals.input !== null &&
    totals.cachedInput !== null &&
    totals.cachedInput <= totals.input
      ? totals.input - totals.cachedInput
      : null;
  return {
    kind: "token-windows",
    samples: valid,
    occurrences,
    ...totals,
    nonCachedInput,
    model: models.size === 1 ? [...models][0]! : null,
    serviceTier: serviceTiers.size === 1 ? [...serviceTiers][0]! : null,
    boundary: "调用前最近累计采样到匹配返回后首个累计采样；重叠窗口按并集合并",
    callIds: [...callIds],
    attribution:
      callIds.size > valid
        ? "shared-window"
        : models.size > 1
          ? "mixed"
          : "single-call",
  };
}

export function subtractUsage(
  current: TokenUsageCounts,
  previous: TokenUsageCounts,
): TokenUsageCounts | null {
  const required: Array<keyof TokenUsageCounts> = ["input", "output", "total"];
  if (
    required.some(
      (key) =>
        current[key] === null ||
        previous[key] === null ||
        current[key]! < previous[key]!,
    )
  )
    return null;
  const result = emptyCounts();
  for (const key of Object.keys(result) as Array<keyof TokenUsageCounts>) {
    const next = current[key];
    const base = previous[key];
    result[key] = next === null || base === null ? null : next - base;
  }
  return result;
}

function mergeWindows(windows: TokenWindow[]): TokenWindow[] {
  const sorted = [...windows]
    .filter((window) => window.afterIndex > window.beforeIndex)
    .sort(
      (left, right) =>
        left.beforeIndex - right.beforeIndex || left.afterIndex - right.afterIndex,
    );
  const merged: TokenWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (!previous || window.beforeIndex > previous.afterIndex) {
      merged.push({ ...window, callIds: [...new Set(window.callIds)] });
      continue;
    }
    previous.afterIndex = Math.max(previous.afterIndex, window.afterIndex);
    previous.callIds = [...new Set([...previous.callIds, ...window.callIds])];
  }
  return merged;
}

function emptyCounts(): TokenUsageCounts {
  return {
    input: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 0,
    reasoningOutput: 0,
    total: 0,
  };
}

function addCounts(target: TokenUsageCounts, value: TokenUsageCounts): void {
  for (const key of Object.keys(target) as Array<keyof TokenUsageCounts>) {
    target[key] =
      target[key] === null || value[key] === null
        ? null
        : target[key]! + value[key]!;
  }
}

function counter(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function optionalCounter(value: unknown): number | null {
  return value === undefined || value === null ? null : counter(value);
}
