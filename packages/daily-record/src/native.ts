import { readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DailyMaterial,
  DailyProvider,
  DailySourceReceipt,
} from "@runweave/shared/daily-record";
import { dayFormatter, hash } from "./data.js";
import { NativeFileIndex, indexScope, pruneIndex, type NativeLine as Line, type NativeIndexMetrics } from "./native-index.js";

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");

/** Deliberately excludes image data, thinking and reasoning content blocks. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(object)
    .filter((part) =>
      ["text", "input_text", "output_text"].includes(string(part.type)),
    )
    .map((part) => string(part.text))
    .join("\n");
}

function redact(value: string): string {
  return value
    .replace(/\s*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/g, "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, "$1[REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:["']?(?:[A-Za-z0-9_]*(?:token|password|secret|api_key))["']?)\s*[:=]\s*)["']([^"'\r\n]{8,})["']/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /(\b[A-Z_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)\s*=\s*)[^\s"']{8,}/g,
      "$1[REDACTED]",
    );
}

function injected(value: string) {
  const v = value.trim();
  return (
    /^\[runweave-task-supervision:/.test(v) ||
    /^<environment_context>[\s\S]*<\/environment_context>$/.test(v) ||
    /^<skill>\s*<name>[\s\S]*<\/skill>$/.test(v) ||
    (/^# AGENTS\.md instructions/.test(v) && v.includes("<INSTRUCTIONS>")) ||
    /^\[?System (?:reminder|message)/i.test(v)
  );
}

async function filesIn(
  root: string,
  receipt: DailySourceReceipt,
): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        receipt.excluded.symlink = (receipt.excluded.symlink ?? 0) + 1;
        continue;
      }
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(file);
    }
  }
  await visit(root);
  return files;
}

export function nativeRoots(home: string, useEnvironment: boolean) {
  return {
    codex: path.join(
      useEnvironment
        ? (process.env.CODEX_HOME ?? path.join(home, ".codex"))
        : path.join(home, ".codex"),
      "sessions",
    ),
    pi: path.join(
      useEnvironment
        ? (process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi/agent"))
        : path.join(home, ".pi/agent"),
      "sessions",
    ),
    claude: path.join(
      useEnvironment
        ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"))
        : path.join(home, ".claude"),
      "projects",
    ),
    trae: path.join(home, ".trae/cli/sessions"),
  };
}

export async function collectNative(options: {
  from: string;
  to: string;
  timeZone: string;
  home?: string;
  providers?: DailyProvider[];
  excludeThreads?: string[];
  indexDir?: string;
  noIndex?: boolean;
}) {
  const dayAt = dayFormatter(options.timeZone);
  const materials: DailyMaterial[] = [];
  const sources: DailySourceReceipt[] = [];
  const seen = new Set<string>();
  const index: NativeIndexMetrics = { hits: 0, appended: 0, rebuilt: 0, cacheFailures: 0, sourceBytesRead: 0, parsedBytes: 0, indexBytesRead: 0, indexBytesWritten: 0 };
  const indexBase = path.resolve(options.indexDir ?? path.join(options.home ?? os.homedir(), ".cache/runweave/daily-record"));
  const roots = nativeRoots(path.resolve(options.home ?? os.homedir()), !options.home);
  if (!options.noIndex) {
    for (const source of Object.values(roots)) {
      const root = await realpath(source).catch(() => path.resolve(source));
      if (indexBase === root || indexBase.startsWith(root + path.sep)) throw new Error("索引目录不能位于来源目录内");
    }
  }
  for (const [provider, root] of Object.entries(
    roots,
  ) as Array<[DailyProvider, string]>) {
    if (options.providers && !options.providers.includes(provider)) continue;
    const receipt: DailySourceReceipt = {
      provider,
      root,
      status: "complete",
      scannedFiles: 0,
      materials: 0,
      excluded: {},
      issues: [],
    };
    sources.push(receipt);
    let files: string[];
    try {
      receipt.root = await realpath(root);
      files = await filesIn(receipt.root, receipt);
    } catch (error) {
      receipt.status = "unavailable";
      receipt.issues.push(`${root}: ${String(error)}`);
      continue;
    }
    let directory: string | undefined;
    if (!options.noIndex) {
      try { directory = await indexScope(indexBase, receipt.root, provider, options.timeZone); }
      catch { index.cacheFailures++; }
    }
    for (const file of files) {
      let reader: NativeFileIndex;
      try { reader = await NativeFileIndex.open(file, directory, index); }
      catch (error) {
        receipt.issues.push(`${file}: ${String(error)}`); receipt.scannedFiles++; continue;
      }
      const previous = reader.data;
      let threadId = previous?.state.threadId ?? "",
        cwd = previous?.state.cwd ?? "",
        historyStart = previous?.state.historyStart ?? 0,
        origin: DailyMaterial["origin"] = previous?.state.origin ?? "interactive";
      const calls = new Map(previous?.state.calls ?? []);
      const mutationIds = new Set(previous?.state.mutationIds ?? []);
      const messageIds = new Set(previous?.state.messageIds ?? []);
      const fileMaterials: DailyMaterial[] = previous?.materials ?? [];
      const excluded = previous?.excluded ?? {};
      const issues = previous?.issues ?? [];
      const exclude = (key: string) => { excluded[key] = (excluded[key] ?? 0) + 1; };
      function add(
        item: Row,
        role: DailyMaterial["role"],
        value: string,
        timestamp: unknown,
        locator: Line,
        nativeId?: string,
        phase?: string,
      ) {
        if (!value.trim()) return;
        if (role === "user" && injected(value)) {
          exclude("injectedContext");
          return;
        }
        if (!threadId) {
          issues.push(`${file}:${locator.line}: 缺少会话身份`);
          return;
        }
        if (
          typeof timestamp !== "string" ||
          !Number.isFinite(Date.parse(timestamp))
        ) {
          issues.push(`${file}:${locator.line}: 缺少有效消息时间`);
          return;
        }
        const day = dayAt(timestamp);
        // A forced raw scan needs no all-date checkpoint. Keep its original cost
        // profile while retaining parser state for tool associations and replay IDs.
        if (options.noIndex) {
          if (options.excludeThreads?.includes(threadId)) { exclude("dailyRecordThread"); return; }
          if (day < options.from || day > options.to) return;
        }
        const clean = redact(value).trim();
        const id = hash(
          `${provider}\0${threadId}\0${nativeId || `${locator.byteOffset}:${role}`}\0${hash(clean)}`,
        );
        const callId = string(
          item.call_id ?? item.tool_use_id ?? item.toolCallId,
        );
        fileMaterials.push({
          id,
          provider,
          threadId,
          nativeId: nativeId || `${locator.byteOffset}:${role}`,
          cwd,
          origin,
          role,
          ...(phase ? { phase } : {}),
          ...(role === "tool"
            ? {
                toolName:
                  calls.get(callId)?.name ?? string(item.toolName ?? item.name),
                callId,
              }
            : {}),
          ...(item.parentId ? { parentId: string(item.parentId) } : {}),
          occurredAt: new Date(timestamp).toISOString(),
          day,
          text: clean,
          textSha256: hash(clean),
          locator,
        });
      }
      function response(item: Row, timestamp: unknown, locator: Line) {
        const kind = string(item.type);
        const id = string(item.id);
        if (
          [
            "function_call",
            "custom_tool_call",
            "tool_use",
            "toolCall",
          ].includes(kind)
        ) {
          const callId = string(item.call_id ?? item.id);
          const input = item.arguments ?? item.input ?? "";
          calls.set(callId, {
            name: string(item.name),
            input: redact(typeof input === "string" ? input : JSON.stringify(input)),
          });
          return;
        }
        if (
          [
            "function_call_output",
            "custom_tool_call_output",
            "tool_result",
          ].includes(kind)
        ) {
          const callId = string(item.call_id ?? item.tool_use_id);
          const call = calls.get(callId);
          const output = item.output ?? item.content;
          const value =
            typeof output === "string"
              ? output
              : Array.isArray(output)
                ? text(output)
                : JSON.stringify(output ?? "");
          add(
            item,
            "tool",
            `${call ? `工具：${call.name}\n参数：${call.input}\n结果：\n` : ""}${value}`,
            timestamp,
            locator,
            id || `${callId}:result`,
          );
          return;
        }
        if (
          kind !== "message" ||
          !["user", "assistant"].includes(string(item.role))
        )
          return;
        const phase = string(item.phase ?? item.channel);
        if (phase && !["commentary", "final", "final_answer"].includes(phase)) {
          exclude("nonConversation");
          return;
        }
        if (id && messageIds.has(id)) {
          exclude("replayedMessage");
          return;
        }
        if (id) messageIds.add(id);
        add(
          item,
          item.role as "user" | "assistant",
          text(item.content),
          timestamp,
          locator,
          id,
          phase,
        );
      }
      try {
        await reader.scan(
          (row, locator) => {
            const payload = object(row.payload);
            if (
              threadId &&
              typeof row.ordinal === "number" &&
              row.ordinal < historyStart
            ) {
              exclude("inheritedHistory");
              return;
            }
            if (row.type === "session_meta" || row.type === "session") {
              const header = row.type === "session" ? row : payload;
              const id = string(header.id);
              if (threadId && threadId !== id)
                throw new Error("会话身份在文件内变化");
              threadId = id;
              cwd = string(header.cwd);
              if (typeof header.subagent_history_start_ordinal === "number")
                historyStart = header.subagent_history_start_ordinal;
              origin =
                typeof header.source === "object" || header.parent_thread_id
                  ? "subagent"
                  : header.source === "exec"
                    ? "background"
                    : "interactive";
              return;
            }
            if (provider === "codex" && row.type === "response_item")
              response(payload, row.timestamp, locator);
            if (provider === "trae" || provider === "codex") {
              if (provider === "trae" && row.type === "response_item")
                response(payload, row.timestamp, locator);
              if (row.type !== "history_mutation") return;
              const commit = string(payload.commit_id);
              if (commit && mutationIds.has(commit)) {
                exclude("replayedCommit");
                return;
              }
              if (commit) mutationIds.add(commit);
              if (payload.operation === "rollback") {
                exclude("historyRollback");
                return;
              }
              if (payload.operation === "replace") {
                for (const item of Array.isArray(payload.items)
                  ? payload.items
                  : []) {
                  const id = string(object(item).id);
                  if (id) messageIds.add(id);
                }
                exclude("historyReplacement");
                return;
              }
              if (payload.operation !== "append") {
                issues.push(
                  `${file}:${locator.line}: 未支持的 history_mutation`,
                );
                return;
              }
              for (const item of Array.isArray(payload.items)
                ? payload.items
                : [])
                response(object(item), row.timestamp, locator);
            }
            if (provider === "pi" && row.type === "message") {
              const message = object(row.message);
              const content = message.content;
              if (message.role === "toolResult") {
                const callId = string(message.toolCallId);
                const call = calls.get(callId);
                add(
                  message,
                  "tool",
                  `${call ? `工具：${call.name}\n参数：${call.input}\n结果：\n` : ""}${text(content)}`,
                  row.timestamp,
                  locator,
                  string(row.id),
                );
              } else {
                for (const part of Array.isArray(content) ? content : [])
                  response(object(part), row.timestamp, locator);
                response(
                  {
                    ...message,
                    type: "message",
                    id: row.id,
                    parentId: row.parentId,
                  },
                  row.timestamp,
                  locator,
                );
              }
            }
            if (
              provider === "claude" &&
              ["user", "assistant"].includes(string(row.type))
            ) {
              const message = object(row.message);
              threadId ||= string(row.sessionId);
              cwd ||= string(row.cwd);
              if (row.isSidechain === true) origin = "subagent";
              for (const part of Array.isArray(message.content)
                ? message.content
                : [])
                response(object(part), row.timestamp, locator);
              response(
                {
                  ...message,
                  type: "message",
                  id: row.uuid,
                  parentId: row.parentUuid,
                },
                row.timestamp,
                locator,
              );
            }
          },
          issues,
        );
        await reader.finish({
          state: { threadId, cwd, historyStart, origin, calls: [...calls], mutationIds: [...mutationIds], messageIds: [...messageIds] },
          materials: fileMaterials, excluded, issues: [...new Set(issues)],
        });
        for (const item of fileMaterials) {
          if (options.excludeThreads?.includes(item.threadId)) {
            receipt.excluded.dailyRecordThread = (receipt.excluded.dailyRecordThread ?? 0) + 1; continue;
          }
          if (item.day < options.from || item.day > options.to) continue;
          if (seen.has(item.id)) { receipt.excluded.duplicate = (receipt.excluded.duplicate ?? 0) + 1; continue; }
          seen.add(item.id); materials.push(item);
        }
        if (reader.incompleteTail) receipt.excluded.incompleteTail = (receipt.excluded.incompleteTail ?? 0) + 1;
      } catch (error) {
        // Keep other sources usable, but never publish a partially read/replaced file as complete.
        receipt.issues.push(`${file}: ${String(error)}`);
      } finally {
        for (const [key, count] of Object.entries(excluded)) receipt.excluded[key] = (receipt.excluded[key] ?? 0) + count;
        receipt.issues.push(...new Set(issues));
        await reader.close();
      }
      receipt.scannedFiles++;
    }
    if (directory) await pruneIndex(directory, files).catch(() => { index.cacheFailures++; });
    if (receipt.issues.length) receipt.status = "partial";
    receipt.materials = materials.filter(
      (item) => item.provider === provider,
    ).length;
  }
  materials.sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
  );
  return { materials, sources, index };
}
