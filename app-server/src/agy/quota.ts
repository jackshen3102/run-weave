import { spawn } from "node:child_process";
import { ConfigurationError } from "@runweave/config-node";
import { resolveAgyConfiguration } from "@runweave/config-node/agy";
import {
  AGY_QUOTA_CACHE_MS,
  emptyAgyQuota,
  type AgyQuotaGroup,
  type AgyQuotaSnapshot,
  type AgyQuotaStatus,
  type AgyQuotaWindow,
  type AgyQuotaWindowKind,
} from "@runweave/shared/app-server/agy-quota";

export interface AgyQuotaCliRunner {
  runQuotaCommand(): Promise<{ stdout: string; stderr: string }>;
}

const AGY_QUOTA_TIMEOUT_MS = 45_000;
const AGY_QUOTA_MAX_BUFFER = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function classifyWindow(rawWindow: string, rawName: string): {
  kind: AgyQuotaWindowKind;
  windowDurationMins: number;
  label: string;
} {
  const token = rawWindow.trim().toLowerCase();
  const name = rawName.trim();
  if (token === "weekly" || token === "7d" || /weekly|7[- ]?day|week/i.test(name)) {
    return { kind: "weekly", windowDurationMins: 10_080, label: "每周剩余" };
  }
  if (token === "5h" || /five[- ]?hour|5[- ]?hour|5h/i.test(name)) {
    return { kind: "shortWindow", windowDurationMins: 300, label: "5 小时剩余" };
  }
  if (token === "daily" || token === "24h" || /daily|24[- ]?hour|24h/i.test(name)) {
    return { kind: "other", windowDurationMins: 1_440, label: "每日剩余" };
  }
  return { kind: "other", windowDurationMins: 300, label: name || "周期剩余" };
}

function parseResetTimestamp(rawReset: unknown): number | null {
  if (typeof rawReset === "number" && Number.isFinite(rawReset)) {
    return rawReset > 0 && rawReset <= 8_640_000_000_000 ? Math.floor(rawReset) : null;
  }
  if (typeof rawReset === "string" && rawReset.trim()) {
    const parsedMs = Date.parse(rawReset.trim());
    if (!Number.isFinite(parsedMs)) return null;
    const sec = Math.floor(parsedMs / 1_000);
    // Antigravity returns "1970-01-01T00:00:00Z" (0) when a rolling 5h window has not been triggered.
    return sec > 0 && sec <= 8_640_000_000_000 ? sec : null;
  }
  return null;
}

function parseBucketWindow(value: unknown, index: number): AgyQuotaWindow | null {
  const data = record(value);
  if (!data) return null;
  const remainingFraction =
    typeof data.remaining_fraction === "number" && Number.isFinite(data.remaining_fraction)
      ? Math.max(0, Math.min(1, data.remaining_fraction))
      : typeof data.remainingFraction === "number" && Number.isFinite(data.remainingFraction)
        ? Math.max(0, Math.min(1, data.remainingFraction))
        : null;
  if (remainingFraction === null) return null;
  const rawName = typeof data.name === "string" ? data.name : "";
  const rawWindow = typeof data.window === "string" ? data.window : "";
  const { kind, windowDurationMins, label } = classifyWindow(rawWindow, rawName);
  const rawId = typeof data.id === "string" && data.id.trim() ? data.id.trim() : `${kind}-${index}`;
  const usedPercent = Math.max(
    0,
    Math.min(100, Number(((1 - remainingFraction) * 100).toFixed(2))),
  );
  return {
    id: rawId,
    label,
    kind,
    usedPercent,
    windowDurationMins,
    resetsAt: parseResetTimestamp(data.reset_time ?? data.resetsAt),
  };
}

function parseGroup(value: unknown, index: number): AgyQuotaGroup | null {
  const data = record(value);
  if (!data || typeof data.name !== "string" || !data.name.trim()) return null;
  const rawBuckets = Array.isArray(data.buckets) ? data.buckets : [];
  const windows = rawBuckets
    .map((bucket, bucketIndex) => parseBucketWindow(bucket, bucketIndex))
    .filter((item): item is AgyQuotaWindow => item !== null);
  if (windows.length === 0) return null;
  const name = data.name.trim();
  const description =
    typeof data.description === "string" && data.description.trim()
      ? data.description.trim()
      : null;
  return {
    id: slugify(name, `group-${index}`),
    name,
    description,
    weekly: windows.find((item) => item.kind === "weekly") ?? null,
    shortWindow: windows.find((item) => item.kind === "shortWindow") ?? null,
    windows,
  };
}

function parseTabSeparatedResponse(responseText: string): AgyQuotaGroup[] {
  const byGroup = new Map<string, AgyQuotaWindow[]>();
  const lines = responseText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i]!.split("\t").map((part) => part.trim());
    if (parts.length < 3) continue;
    const [groupName, bucketName, remainingText, resetText] = parts;
    if (!groupName || !bucketName || !remainingText) continue;
    const percentMatch = /^(\d+(?:\.\d+)?)%$/.exec(remainingText);
    if (!percentMatch) continue;
    const remainingPercent = Math.max(0, Math.min(100, Number(percentMatch[1])));
    const { kind, windowDurationMins, label } = classifyWindow("", bucketName);
    const list = byGroup.get(groupName) ?? [];
    list.push({
      id: `${slugify(groupName, "group")}-${kind}-${list.length}`,
      label,
      kind,
      usedPercent: Math.max(0, Math.min(100, Number((100 - remainingPercent).toFixed(2)))),
      windowDurationMins,
      resetsAt: parseResetTimestamp(resetText),
    });
    byGroup.set(groupName, list);
  }
  const groups: AgyQuotaGroup[] = [];
  let index = 0;
  for (const [name, windows] of byGroup.entries()) {
    groups.push({
      id: slugify(name, `group-${index}`),
      name,
      description: null,
      weekly: windows.find((item) => item.kind === "weekly") ?? null,
      shortWindow: windows.find((item) => item.kind === "shortWindow") ?? null,
      windows,
    });
    index += 1;
  }
  return groups;
}

function classifyFailureStatus(text: string): AgyQuotaStatus {
  if (/not logged in|sign in|login required|unauthenticated|authentication failed|oauth|credentials/i.test(text)) {
    return "not_logged_in";
  }
  if (/GEMINI_API_KEY|not available|unknown command|unsupported|ENOENT|not found/i.test(text)) {
    return "unsupported";
  }
  return "error";
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return record(JSON.parse(trimmed.slice(start, end + 1)));
      } catch {
        return null;
      }
    }
    return null;
  }
}

class DefaultAgyQuotaCliRunner implements AgyQuotaCliRunner {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async runQuotaCommand(): Promise<{ stdout: string; stderr: string }> {
    const { binary } = resolveAgyConfiguration(this.env);
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ["-p", "/quota", "--output-format", "json"], {
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => {
          if (stdout.trim()) resolve({ stdout, stderr });
          else reject(Object.assign(new Error("AGY quota command timed out"), { stderr }));
        });
      }, AGY_QUOTA_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < AGY_QUOTA_MAX_BUFFER) {
          stdout += chunk.toString("utf8");
        }
        if (extractJsonObject(stdout)) {
          child.kill("SIGTERM");
          finish(() => resolve({ stdout, stderr }));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < AGY_QUOTA_MAX_BUFFER) {
          stderr += chunk.toString("utf8");
        }
      });
      child.on("error", (error) => {
        finish(() => reject(Object.assign(error, { stderr })));
      });
      child.on("close", (code) => {
        finish(() => {
          if (code !== 0 && !stdout.trim()) {
            reject(Object.assign(new Error(`agy exited with code ${code}`), { stderr }));
            return;
          }
          resolve({ stdout, stderr });
        });
      });
    });
  }
}

/** Read-only, process-local cache for Antigravity (agy) subscription quota. */
export class AgyQuotaService {
  private value = emptyAgyQuota("unavailable");
  private observedMonotonic: number | null = null;
  private flight: Promise<AgyQuotaSnapshot> | null = null;
  private readonly runner: AgyQuotaCliRunner;

  constructor(runner?: AgyQuotaCliRunner) {
    this.runner = runner ?? new DefaultAgyQuotaCliRunner();
  }

  async read(force = false): Promise<AgyQuotaSnapshot> {
    if (this.flight) return this.flight;
    const snapshot = this.snapshot();
    const resetPassed = snapshot.groups.some((group) =>
      group.windows.some((item) => item.resetsAt !== null && item.resetsAt * 1_000 <= Date.now()),
    );
    if (
      !force &&
      snapshot.status === "ok" &&
      snapshot.sampleAgeMs !== null &&
      snapshot.sampleAgeMs < AGY_QUOTA_CACHE_MS &&
      !resetPassed
    ) {
      return snapshot;
    }
    this.flight = this.collect().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  private snapshot(): AgyQuotaSnapshot {
    return {
      ...this.value,
      sampleAgeMs:
        this.observedMonotonic === null
          ? null
          : Math.max(0, performance.now() - this.observedMonotonic),
    };
  }

  private clear(status: AgyQuotaStatus): void {
    this.value = emptyAgyQuota(status);
    this.observedMonotonic = null;
  }

  private async collect(): Promise<AgyQuotaSnapshot> {
    try {
      const { stdout, stderr } = await this.runner.runQuotaCommand();
      const payload = extractJsonObject(stdout);
      if (!payload) {
        const status = classifyFailureStatus(`${stdout}\n${stderr}`);
        if (status === "not_logged_in" || status === "unsupported") this.clear(status);
        else this.value = { ...this.value, status };
        return this.snapshot();
      }
      const command = record(payload.command);
      const data = record(command?.data);
      const rawGroups = Array.isArray(data?.groups) ? data.groups : [];
      let groups = rawGroups
        .map((group, index) => parseGroup(group, index))
        .filter((item): item is AgyQuotaGroup => item !== null);
      if (groups.length === 0 && typeof payload.response === "string") {
        groups = parseTabSeparatedResponse(payload.response);
      }
      if (groups.length === 0) {
        const responseText = typeof payload.response === "string" ? payload.response : "";
        const status = classifyFailureStatus(`${responseText}\n${stderr}`);
        if (status === "not_logged_in" || status === "unsupported") this.clear(status);
        else this.value = { ...this.value, status };
        return this.snapshot();
      }
      this.value = {
        protocolVersion: 1,
        status: "ok",
        observedAt: new Date().toISOString(),
        sampleAgeMs: 0,
        groups,
      };
      this.observedMonotonic = performance.now();
    } catch (error) {
      if (error instanceof ConfigurationError) {
        this.clear("unsupported");
        return this.snapshot();
      }
      const code = (error as NodeJS.ErrnoException)?.code;
      const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
      const message = error instanceof Error ? error.message : String(error);
      const status = code === "ENOENT" ? "unsupported" : classifyFailureStatus(`${message}\n${stderr}`);
      if (status === "not_logged_in" || status === "unsupported") {
        this.clear(status);
      } else {
        this.value = { ...this.value, status };
      }
    }
    return this.snapshot();
  }
}
