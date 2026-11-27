export const AGY_QUOTA_CACHE_MS = 5 * 60 * 1_000;

export type AgyQuotaWindowKind = "weekly" | "shortWindow" | "other";

export interface AgyQuotaWindow {
  id: string;
  label: string;
  kind: AgyQuotaWindowKind;
  usedPercent: number;
  windowDurationMins: number;
  /** Unix seconds from Antigravity; null means reset time is unknown or window not yet active. */
  resetsAt: number | null;
}

export interface AgyQuotaGroup {
  id: string;
  name: string;
  description: string | null;
  weekly: AgyQuotaWindow | null;
  shortWindow: AgyQuotaWindow | null;
  windows: AgyQuotaWindow[];
}

export type AgyQuotaStatus =
  | "ok"
  | "unavailable"
  | "incompatible"
  | "unsupported"
  | "not_logged_in"
  | "error";

/** One Antigravity (AGY) subscription quota snapshot, grouped by model quota pool. */
export interface AgyQuotaSnapshot {
  protocolVersion: 1;
  status: AgyQuotaStatus;
  observedAt: string | null;
  sampleAgeMs: number | null;
  groups: AgyQuotaGroup[];
}

export type QuotaPaceState = "ahead" | "on" | "under";

export interface QuotaWindowPace {
  remainingPercent: number;
  evenPaceRemainingPercent: number | null;
  pace: QuotaPaceState | null;
}

export const QUOTA_PACE_LABELS: Record<QuotaPaceState, string> = {
  ahead: "消耗偏快",
  on: "进度均衡",
  under: "余量充裕",
};

/**
 * T3 Code style even-pace benchmark calculation for a rolling quota window.
 * Compares actual used percentage against elapsed time fraction in the window.
 */
export function computeQuotaWindowPace(
  window: { usedPercent: number; windowDurationMins: number; resetsAt: number | null },
  nowMs = Date.now(),
): QuotaWindowPace {
  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
  if (
    window.resetsAt === null ||
    !Number.isFinite(window.resetsAt) ||
    window.windowDurationMins <= 0 ||
    !Number.isFinite(window.windowDurationMins)
  ) {
    return { remainingPercent, evenPaceRemainingPercent: null, pace: null };
  }
  const durationSec = window.windowDurationMins * 60;
  const remainingTimeSec = window.resetsAt - nowMs / 1_000;
  if (remainingTimeSec <= 0 || remainingTimeSec > durationSec) {
    return { remainingPercent, evenPaceRemainingPercent: null, pace: null };
  }
  const elapsedFraction = Math.max(0, Math.min(1, (durationSec - remainingTimeSec) / durationSec));
  const evenPaceRemainingPercent = Math.max(0, Math.min(100, (1 - elapsedFraction) * 100));
  const delta = window.usedPercent - elapsedFraction * 100;
  const pace: QuotaPaceState = delta > 5 ? "ahead" : delta < -5 ? "under" : "on";
  return { remainingPercent, evenPaceRemainingPercent, pace };
}

export function emptyAgyQuota(status: AgyQuotaStatus): AgyQuotaSnapshot {
  return {
    protocolVersion: 1,
    status,
    observedAt: null,
    sampleAgeMs: null,
    groups: [],
  };
}

function parseAgyQuotaWindow(input: unknown): AgyQuotaWindow | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const item = input as Record<string, unknown>;
  const kinds: AgyQuotaWindowKind[] = ["weekly", "shortWindow", "other"];
  if (
    typeof item.id !== "string" ||
    !item.id.trim() ||
    typeof item.label !== "string" ||
    !item.label.trim() ||
    !kinds.includes(item.kind as AgyQuotaWindowKind) ||
    typeof item.usedPercent !== "number" ||
    !Number.isFinite(item.usedPercent) ||
    item.usedPercent < 0 ||
    item.usedPercent > 100 ||
    typeof item.windowDurationMins !== "number" ||
    !Number.isFinite(item.windowDurationMins) ||
    item.windowDurationMins <= 0 ||
    !(
      item.resetsAt === null ||
      (typeof item.resetsAt === "number" &&
        Number.isFinite(item.resetsAt) &&
        item.resetsAt > 0 &&
        item.resetsAt <= 8_640_000_000_000)
    )
  ) {
    return undefined;
  }
  return {
    id: item.id.trim(),
    label: item.label.trim(),
    kind: item.kind as AgyQuotaWindowKind,
    usedPercent: item.usedPercent,
    windowDurationMins: item.windowDurationMins,
    resetsAt: item.resetsAt as number | null,
  };
}

function parseAgyQuotaGroup(input: unknown): AgyQuotaGroup | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const item = input as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    !item.id.trim() ||
    typeof item.name !== "string" ||
    !item.name.trim() ||
    !(item.description === null || typeof item.description === "string") ||
    !Array.isArray(item.windows)
  ) {
    return undefined;
  }
  const weekly = item.weekly === null ? null : parseAgyQuotaWindow(item.weekly);
  const shortWindow = item.shortWindow === null ? null : parseAgyQuotaWindow(item.shortWindow);
  if (weekly === undefined || shortWindow === undefined) return undefined;
  const windows: AgyQuotaWindow[] = [];
  for (const rawWindow of item.windows) {
    const parsed = parseAgyQuotaWindow(rawWindow);
    if (!parsed) return undefined;
    windows.push(parsed);
  }
  return {
    id: item.id.trim(),
    name: item.name.trim(),
    description: item.description ? item.description.trim() : null,
    weekly,
    shortWindow,
    windows,
  };
}

/** Validate and select only public fields when crossing a runtime boundary. */
export function parseAgyQuotaSnapshot(value: unknown): AgyQuotaSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const statuses: AgyQuotaStatus[] = [
    "ok",
    "unavailable",
    "incompatible",
    "unsupported",
    "not_logged_in",
    "error",
  ];
  if (
    data.protocolVersion !== 1 ||
    !statuses.includes(data.status as AgyQuotaStatus) ||
    !(
      data.observedAt === null ||
      (typeof data.observedAt === "string" && Number.isFinite(Date.parse(data.observedAt)))
    ) ||
    !(
      data.sampleAgeMs === null ||
      (typeof data.sampleAgeMs === "number" &&
        Number.isFinite(data.sampleAgeMs) &&
        data.sampleAgeMs >= 0)
    ) ||
    !Array.isArray(data.groups)
  ) {
    return null;
  }
  const groups: AgyQuotaGroup[] = [];
  for (const rawGroup of data.groups) {
    const parsed = parseAgyQuotaGroup(rawGroup);
    if (!parsed) return null;
    groups.push(parsed);
  }
  return {
    protocolVersion: 1,
    status: data.status as AgyQuotaStatus,
    observedAt: data.observedAt as string | null,
    sampleAgeMs: data.sampleAgeMs as number | null,
    groups,
  };
}

export const AGY_QUOTA_STATUS_LABELS: Record<AgyQuotaStatus, string> = {
  ok: "",
  unavailable: "AGY 额度服务暂不可用",
  incompatible: "当前服务版本不支持 AGY 额度，请更新后重试",
  unsupported: "当前环境未安装或不支持 Antigravity (agy) 订阅额度",
  not_logged_in: "请先在当前电脑完成 Antigravity (agy) 账号登录",
  error: "AGY 额度更新失败，请稍后重试",
};
