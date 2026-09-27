import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  EfficiencyAnalysisRun,
  TokenUsageCounts,
} from "@runweave/shared/execution-efficiency";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import { parseUsageSample, type RawTokenUsage } from "./collector/usage";

export async function recoverAnalysisUsage(
  analysis: EfficiencyAnalysisRun,
  scheduledRun: ScheduledRun,
  logRoots: string[],
): Promise<EfficiencyAnalysisRun> {
  if (!isFinished(scheduledRun.status)) return analysis;
  const threadId = scheduledRun.threadRef?.threadId ?? analysis.threadId;
  if (!threadId) {
    return {
      ...analysis,
      analysisUsageCompleteness: "unavailable",
    };
  }
  const file = await findSessionFile(logRoots, threadId);
  if (!file) {
    return {
      ...analysis,
      threadId,
      analysisUsageCompleteness: "unavailable",
    };
  }
  const usage = await readLastUsage(file);
  return {
    ...analysis,
    threadId,
    analysisUsage: usage,
    analysisUsageCompleteness: usage
      ? Object.values(usage).some((value) => value === null)
        ? "partial"
        : "complete"
      : "unavailable",
  };
}

async function findSessionFile(
  roots: string[],
  threadId: string,
): Promise<string | null> {
  const pending = [...roots];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (entry.name.includes(threadId)) return target;
        const header = await readHeaderId(target);
        if (header === threadId) return target;
      }
    }
  }
  return null;
}

async function readHeaderId(file: string): Promise<string | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(1_024 * 1_024);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, result.bytesRead).toString("utf8").split(/\r?\n/u)[0];
    if (!line) return null;
    const record = JSON.parse(line) as { type?: unknown; payload?: { id?: unknown } };
    return record.type === "session_meta" && typeof record.payload?.id === "string"
      ? record.payload.id
      : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function readLastUsage(file: string): Promise<TokenUsageCounts | null> {
  const info = await stat(file);
  if (info.size > 64 * 1_024 * 1_024) return null;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(info.size);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, result.bytesRead).toString("utf8").split(/\r?\n/u);
    let latest: TokenUsageCounts | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const record = JSON.parse(line) as {
          type?: unknown;
          timestamp?: unknown;
          payload?: { type?: unknown; info?: { total_token_usage?: unknown } };
        };
        if (record.type !== "event_msg" || record.payload?.type !== "token_count")
          continue;
        const sample = parseUsageSample(
          record.payload.info?.total_token_usage as RawTokenUsage,
          {
            line: index + 1,
            observedAt:
              typeof record.timestamp === "string"
                ? record.timestamp
                : new Date(0).toISOString(),
          },
        );
        if (sample) {
          latest = {
            input: sample.input,
            cachedInput: sample.cachedInput,
            cacheWriteInput: sample.cacheWriteInput,
            output: sample.output,
            reasoningOutput: sample.reasoningOutput,
            total: sample.total,
          };
        }
      } catch {
        continue;
      }
    }
    return latest;
  } finally {
    await handle.close();
  }
}

function isFinished(status: ScheduledRun["status"]): boolean {
  return new Set(["completed", "failed", "cancelled", "skipped"]).has(status);
}
