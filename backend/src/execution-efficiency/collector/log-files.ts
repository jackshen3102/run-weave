import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EfficiencyCoverage } from "@runweave/shared/execution-efficiency";

export const MAX_BATCH_BYTES = 64 * 1_024 * 1_024;

export interface LogCandidate {
  file: string;
  size: number;
  modifiedAt: number;
  generation: string;
}

export function resolveCodexLogRoots(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
): string[] {
  const configured = env.RUNWEAVE_EFFICIENCY_LOG_ROOT?.trim();
  if (configured) return [path.resolve(expandHome(configured, homeDir))];
  const codexHome = path.resolve(
    expandHome(env.CODEX_HOME?.trim() || path.join(homeDir, ".codex"), homeDir),
  );
  return [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
}

export async function listLogFiles(
  roots: string[],
  since: number,
  coverage: EfficiencyCoverage,
): Promise<LogCandidate[]> {
  const files: LogCandidate[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "unavailable";
      if (!coverage.unknownReasons.includes(code)) coverage.unknownReasons.push(code);
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return visit(target);
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
        const info = await stat(target).catch(() => null);
        if (!info || info.mtimeMs < since || info.size > MAX_BATCH_BYTES) return;
        files.push({
          file: target,
          size: info.size,
          modifiedAt: info.mtimeMs,
          generation: `${info.dev}:${info.ino}:${info.birthtimeMs}`,
        });
      }),
    );
  }
  await Promise.all(roots.map((root) => visit(root)));
  return files.sort(
    (left, right) =>
      left.modifiedAt - right.modifiedAt || left.file.localeCompare(right.file),
  );
}

export async function readSessionHeader(
  file: string,
): Promise<{ threadId: string; cwd: string } | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(1_024 * 1_024);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, result.bytesRead).toString("utf8").split(/\r?\n/u)[0];
    if (!line) return null;
    const record = JSON.parse(line) as Record<string, unknown>;
    const payload = object(record.payload);
    const threadId = string(payload?.id);
    const cwd = string(payload?.cwd);
    return record.type === "session_meta" && threadId && cwd
      ? { threadId, cwd }
      : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function expandHome(value: string, homeDir: string): string {
  return value === "~"
    ? homeDir
    : value.startsWith("~/")
      ? path.join(homeDir, value.slice(2))
      : value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
