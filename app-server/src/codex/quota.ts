import {
  CODEX_QUOTA_CACHE_MS,
  emptyCodexQuota,
  type CodexQuotaSnapshot,
  type CodexQuotaWindow,
} from "@runweave/shared/app-server/codex-quota";

interface QuotaReader {
  readQuotaAccount(): Promise<unknown>;
  readRateLimits(): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function window(value: unknown): CodexQuotaWindow | null {
  const data = record(value);
  if (!data || typeof data.usedPercent !== "number" || !Number.isFinite(data.usedPercent)
    || data.usedPercent < 0 || data.usedPercent > 100
    || typeof data.windowDurationMins !== "number" || !Number.isFinite(data.windowDurationMins)
    || data.windowDurationMins <= 0) return null;
  return {
    usedPercent: data.usedPercent,
    windowDurationMins: data.windowDurationMins,
    resetsAt: typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt)
      && data.resetsAt >= 0 && data.resetsAt <= 8_640_000_000_000 ? data.resetsAt : null,
  };
}

/** Read-only, process-local cache. No timer, persisted history or account credentials. */
export class CodexQuotaService {
  private value = emptyCodexQuota("unavailable");
  private observedMonotonic: number | null = null;
  private flight: Promise<CodexQuotaSnapshot> | null = null;
  private accountScope: string | null = null;

  constructor(private readonly reader: QuotaReader) {}

  async read(force = false): Promise<CodexQuotaSnapshot> {
    if (this.flight) return this.flight;
    const snapshot = this.snapshot();
    const resetPassed = [snapshot.weekly, snapshot.shortWindow].some(
      (item) => item?.resetsAt != null && item.resetsAt * 1_000 <= Date.now(),
    );
    if (!force && snapshot.status === "ok" && snapshot.sampleAgeMs !== null
      && snapshot.sampleAgeMs < CODEX_QUOTA_CACHE_MS && !resetPassed) return snapshot;
    this.flight = this.collect().finally(() => { this.flight = null; });
    return this.flight;
  }

  private snapshot(): CodexQuotaSnapshot {
    return { ...this.value, sampleAgeMs: this.observedMonotonic === null
      ? null : Math.max(0, performance.now() - this.observedMonotonic) };
  }

  private clear(status: CodexQuotaSnapshot["status"]): void {
    this.value = emptyCodexQuota(status);
    this.observedMonotonic = null;
    this.accountScope = null;
  }

  private async collect(): Promise<CodexQuotaSnapshot> {
    try {
      const response = record(await this.reader.readQuotaAccount());
      if (!response || !("account" in response)) throw new Error("Invalid account response");
      const account = record(response.account);
      if (!account) {
        this.clear("not_logged_in");
        return this.snapshot();
      }
      if (account.type !== "chatgpt") {
        this.clear("unsupported");
        return this.snapshot();
      }
      // Identity stays private; changing the observed login invalidates old samples.
      const scope = JSON.stringify([account.email ?? null, account.planType ?? null]);
      if (this.accountScope !== scope) this.clear("unavailable");
      this.accountScope = scope;
      const limits = record(await this.reader.readRateLimits());
      if (!limits || !("rateLimits" in limits || "rateLimitsByLimitId" in limits)) {
        throw new Error("Invalid rate limits response");
      }
      const buckets = record(limits.rateLimitsByLimitId);
      const legacy = record(limits.rateLimits);
      // Never display a different metered bucket as the subscription's Codex quota.
      const bucket = buckets ? record(buckets.codex)
        : legacy && (legacy.limitId == null || legacy.limitId === "codex") ? legacy : null;
      const windows = [window(bucket?.primary), window(bucket?.secondary)]
        .filter((item): item is CodexQuotaWindow => item !== null);
      this.value = {
        protocolVersion: 1, status: "ok", observedAt: new Date().toISOString(), sampleAgeMs: 0,
        weekly: windows.find((item) => item.windowDurationMins === 10_080) ?? null,
        shortWindow: windows.find((item) => item.windowDurationMins < 10_080) ?? null,
      };
      this.observedMonotonic = performance.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Only classify errors locally; raw RPC errors/stderr never cross this boundary.
      this.value = { ...this.value, status: /unknown method|method not found|unsupported/i.test(message)
        ? "unsupported" : "error" };
    }
    return this.snapshot();
  }
}
