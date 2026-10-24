import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DailyMaterial,
  DailyProvider,
  DailySourceReceipt,
} from "@runweave/shared/daily-record";
import { dayFormatter, hash } from "./data.js";

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

interface Line {
  path: string;
  line: number;
  byteOffset: number;
  byteLength: number;
  sha256: string;
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

/** Read only complete lines inside the file length captured at open, with exact byte locators. */
async function scan(
  file: string,
  consume: (row: Row, locator: Line) => void,
  receipt: DailySourceReceipt,
) {
  if ((await realpath(file)) !== file) throw new Error("源文件包含软链接");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const buffer = Buffer.alloc(512 * 1024);
    let position = 0,
      offset = 0,
      line = 0;
    let pending = Buffer.alloc(0),
      discarding = false;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (!bytesRead) throw new Error("源文件读取期间被截断");
      position += bytesRead;
      const bytes = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let start = 0,
        end: number;
      while ((end = bytes.indexOf(10, start)) !== -1) {
        line++;
        const raw = bytes.subarray(start, end + 1);
        if (!discarding && raw.length > 1) {
          let row: Row;
          try {
            row = object(JSON.parse(raw.toString("utf8")));
          } catch {
            receipt.issues.push(`${file}:${line}: 非法 JSON`);
            start = end + 1;
            offset += raw.length;
            continue;
          }
          consume(row, {
            path: file,
            line,
            byteOffset: offset,
            byteLength: raw.length,
            sha256: hash(raw),
          });
        }
        discarding = false;
        offset += raw.length;
        start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
      if (discarding || pending.length > 16 * 1024 * 1024) {
        if (!discarding)
          receipt.issues.push(`${file}:${line + 1}: 单行超过 16 MiB，未采集`);
        discarding = true;
        offset += pending.length;
        pending = Buffer.alloc(0);
      }
    }
    if (pending.length || discarding)
      receipt.excluded.incompleteTail =
        (receipt.excluded.incompleteTail ?? 0) + 1;
    const after = await handle.stat();
    if (
      after.size < before.size ||
      after.ino !== before.ino ||
      (after.size === before.size && after.mtimeMs !== before.mtimeMs)
    ) {
      throw new Error("源文件读取期间发生重写，需重新采集");
    }
  } finally {
    await handle.close();
  }
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
}) {
  const dayAt = dayFormatter(options.timeZone);
  const materials: DailyMaterial[] = [];
  const sources: DailySourceReceipt[] = [];
  const seen = new Set<string>();
  for (const [provider, root] of Object.entries(
    nativeRoots(path.resolve(options.home ?? os.homedir()), !options.home),
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
    const exclude = (key: string) => {
      receipt.excluded[key] = (receipt.excluded[key] ?? 0) + 1;
    };
    let files: string[];
    try {
      receipt.root = await realpath(root);
      files = await filesIn(receipt.root, receipt);
    } catch (error) {
      receipt.status = "unavailable";
      receipt.issues.push(`${root}: ${String(error)}`);
      continue;
    }
    for (const file of files) {
      let threadId = "",
        cwd = "",
        historyStart = 0,
        origin: DailyMaterial["origin"] = "interactive";
      const calls = new Map<string, { name: string; input: string }>();
      const mutationIds = new Set<string>();
      const messageIds = new Set<string>();
      const fileMaterials: DailyMaterial[] = [];
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
          receipt.issues.push(`${file}:${locator.line}: 缺少会话身份`);
          return;
        }
        if (
          typeof timestamp !== "string" ||
          !Number.isFinite(Date.parse(timestamp))
        ) {
          receipt.issues.push(`${file}:${locator.line}: 缺少有效消息时间`);
          return;
        }
        if (options.excludeThreads?.includes(threadId)) {
          exclude("dailyRecordThread");
          return;
        }
        const day = dayAt(timestamp);
        if (day < options.from || day > options.to) return;
        const clean = redact(value).trim();
        const id = hash(
          `${provider}\0${threadId}\0${nativeId || `${locator.byteOffset}:${role}`}\0${hash(clean)}`,
        );
        if (seen.has(id)) {
          exclude("duplicate");
          return;
        }
        seen.add(id);
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
            input: typeof input === "string" ? input : JSON.stringify(input),
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
        await scan(
          file,
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
                receipt.issues.push(
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
          receipt,
        );
        materials.push(...fileMaterials);
      } catch (error) {
        // Keep other sources usable, but never publish a partially read/replaced file as complete.
        for (const item of fileMaterials) seen.delete(item.id);
        receipt.issues.push(`${file}: ${String(error)}`);
      }
      receipt.scannedFiles++;
    }
    if (receipt.issues.length) receipt.status = "partial";
    receipt.materials = materials.filter(
      (item) => item.provider === provider,
    ).length;
  }
  materials.sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
  );
  return { materials, sources };
}
