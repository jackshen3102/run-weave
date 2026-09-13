export const CODEX_QUOTA_CACHE_MS = 5 * 60 * 1_000;

export interface CodexQuotaWindow {
  usedPercent: number;
  windowDurationMins: number;
  /** Unix seconds from Codex; null means the reset time is unknown. */
  resetsAt: number | null;
}

export type CodexQuotaStatus = "ok" | "unavailable" | "incompatible" | "unsupported" | "not_logged_in" | "error";

/** One Codex subscription snapshot, owned by the selected Runweave App Server. */
export interface CodexQuotaSnapshot {
  protocolVersion: 1;
  status: CodexQuotaStatus;
  observedAt: string | null;
  sampleAgeMs: number | null;
  weekly: CodexQuotaWindow | null;
  shortWindow: CodexQuotaWindow | null;
}

export function emptyCodexQuota(status: CodexQuotaStatus): CodexQuotaSnapshot {
  return { protocolVersion: 1, status, observedAt: null, sampleAgeMs: null, weekly: null, shortWindow: null };
}

/** Validate and select only public fields when crossing a runtime boundary. */
export function parseCodexQuotaSnapshot(value: unknown): CodexQuotaSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const statuses: CodexQuotaStatus[] = ["ok", "unavailable", "incompatible", "unsupported", "not_logged_in", "error"];
  if (data.protocolVersion !== 1 || !statuses.includes(data.status as CodexQuotaStatus)
    || !(data.observedAt === null || typeof data.observedAt === "string" && Number.isFinite(Date.parse(data.observedAt)))
    || !(data.sampleAgeMs === null || typeof data.sampleAgeMs === "number" && Number.isFinite(data.sampleAgeMs) && data.sampleAgeMs >= 0)) return null;
  const parseWindow = (input: unknown): CodexQuotaWindow | null | undefined => {
    if (input === null) return null;
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const item = input as Record<string, unknown>;
    if (typeof item.usedPercent !== "number" || !Number.isFinite(item.usedPercent) || item.usedPercent < 0 || item.usedPercent > 100
      || typeof item.windowDurationMins !== "number" || !Number.isFinite(item.windowDurationMins) || item.windowDurationMins <= 0
      || !(item.resetsAt === null || typeof item.resetsAt === "number" && Number.isFinite(item.resetsAt) && item.resetsAt >= 0 && item.resetsAt <= 8_640_000_000_000)) return undefined;
    return { usedPercent: item.usedPercent, windowDurationMins: item.windowDurationMins, resetsAt: item.resetsAt as number | null };
  };
  const weekly = parseWindow(data.weekly);
  const shortWindow = parseWindow(data.shortWindow);
  if (weekly === undefined || shortWindow === undefined) return null;
  return {
    protocolVersion: 1, status: data.status as CodexQuotaStatus,
    observedAt: data.observedAt as string | null, sampleAgeMs: data.sampleAgeMs as number | null,
    weekly, shortWindow,
  };
}

export const CODEX_QUOTA_STATUS_LABELS: Record<CodexQuotaStatus, string> = {
  ok: "",
  unavailable: "App Server 暂不可用",
  incompatible: "当前服务版本不支持 Codex 额度，请更新后重试",
  unsupported: "当前版本或登录方式不支持 Codex 额度",
  not_logged_in: "请先在 App Server 所在电脑登录 Codex 的 ChatGPT 订阅",
  error: "额度更新失败，请稍后重试",
};
