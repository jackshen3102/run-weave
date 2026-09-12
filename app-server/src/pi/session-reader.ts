import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerThreadRef,
  AppServerThreadDetail,
  AppServerPiThreadDetail,
  AppServerThreadDetailTurn,
} from "@runweave/shared/app-server-events";
import {
  isPiAgentContext,
  type PiAgentContext,
} from "@runweave/shared/terminal/pi-agent";

type Entry = Record<string, unknown> & {
  id?: string;
  parentId?: string | null;
  type?: string;
};
type Lifecycle = PiAgentContext & {
  hook: string;
  timestamp: string;
  terminalSessionId: string;
  tmuxPaneId: string;
  operationId: string | null;
};

/** Reads only a session path registered by an authenticated Pi lifecycle event. */
export class PiSessionReader {
  async read(thread: AppServerThreadRef): Promise<{
    summary: AppServerThreadDetail;
    detail: AppServerPiThreadDetail;
    latest: Lifecycle | null;
  } | null> {
    if (thread.agent !== "pi" || !thread.pi?.sessionFile) return null;
    const file = thread.pi.sessionFile;
    if (!path.isAbsolute(file) || path.extname(file) !== ".jsonl") return null;
    let handle;
    try {
      // Do not follow a path replaced with a symlink after registration.
      if ((await realpath(file)) !== file) return null;
      handle = await open(file, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null;
      const content = await handle.readFile("utf8");
      const lines = content.split("\n");
      lines.pop(); // An incomplete append is not a record.
      const entries: Entry[] = [];
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value && typeof value === "object") entries.push(value);
        } catch {
          /* Keep earlier complete records readable. */
        }
      }
      const header = entries[0];
      if (
        header?.type !== "session" ||
        header.version !== 3 ||
        header.id !== thread.threadId
      )
        return null;
      const byId = new Map(
        entries.flatMap((entry) =>
          typeof entry.id === "string" ? [[entry.id, entry] as const] : [],
        ),
      );
      const facts = entries
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "runweave.lifecycle",
        )
        .map((entry) => entry.data)
        .filter(
          (value): value is Lifecycle =>
            isPiAgentContext(value) &&
            value.sessionId === thread.threadId &&
            typeof (value as Lifecycle).timestamp === "string",
        );
      const latest = facts.at(-1) ?? null;
      const anchor = [...entries]
        .reverse()
        .find(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "runweave.lifecycle",
        );
      // A streaming user/tool message can be appended after the lifecycle callback.
      // Extend the selected leaf only through descendants of that exact anchor.
      let selectedLeaf =
        anchor?.id ?? latest?.leafId ?? thread.pi.leafId ?? null;
      if (selectedLeaf) {
        for (const entry of entries.slice(
          anchor ? entries.indexOf(anchor) + 1 : entries.length,
        )) {
          if (entry.id && entry.parentId === selectedLeaf)
            selectedLeaf = entry.id;
        }
      }
      let cursor = selectedLeaf;
      const branch: Entry[] = [];
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const entry = byId.get(cursor);
        if (!entry) break;
        branch.push(entry);
        cursor = entry.parentId ?? null;
      }
      branch.reverse();
      const turns: AppServerThreadDetailTurn[] = [];
      let current: AppServerThreadDetailTurn | undefined;
      let preview = "";
      for (const entry of branch) {
        if (entry.type === "message") {
          const message = entry.message as Record<string, unknown> | undefined;
          if (
            !message ||
            !["user", "assistant", "toolResult"].includes(String(message.role))
          )
            continue;
          const text =
            (message.role === "toolResult"
              ? `[工具结果: ${String(message.toolName ?? "tool")}]\n`
              : "") + contentText(message.content);
          if (message.role === "user") {
            if (!preview) preview = text.slice(0, 8000);
            current = {
              id: entry.id!,
              status: "completed",
              itemsView: "full",
              itemCount: 0,
              messages: [],
              ...(typeof entry.timestamp === "string"
                ? { startedAt: entry.timestamp }
                : {}),
            };
            turns.push(current);
          }
          if (!current) continue;
          current.messages.push({
            id: entry.id!,
            role: message.role === "user" ? "user" : "assistant",
            text,
          });
          current.itemCount++;
          if (message.role === "assistant") {
            current.status =
              message.stopReason === "error"
                ? "failed"
                : message.stopReason === "aborted"
                  ? "interrupted"
                  : "completed";
            if (typeof entry.timestamp === "string")
              current.completedAt = entry.timestamp;
          }
        } else if (
          entry.type === "compaction" ||
          entry.type === "branch_summary"
        ) {
          if (current && typeof entry.summary === "string") {
            current.messages.push({
              id: entry.id!,
              role: "assistant",
              text: `[上下文摘要]\n${entry.summary}`,
            });
            current.itemCount++;
          }
        }
      }
      const authoritative =
        latest &&
        latest.instanceId === thread.pi.instanceId &&
        latest.sequence >= thread.pi.sequence;
      const status = !authoritative
        ? "unknown"
        : latest.runId && latest.event !== "agent_settled"
          ? "running"
          : "idle";
      if (current && status === "running") current.status = "inProgress";
      const lifecycle = facts
        .filter(
          (fact) =>
            fact.hook === "UserPromptSubmit" || fact.event === "agent_settled",
        )
        .map((fact) => ({
          cursor: `${fact.instanceId}:${fact.sequence}`,
          type:
            fact.event === "agent_settled" ? "task_complete" : "task_started",
          timestamp: fact.timestamp,
          turnId: fact.runId,
          raw: { ...fact },
        }));
      return {
        summary: {
          provider: "pi",
          id: thread.threadId,
          status,
          preview: preview || null,
          turns: turns.map((turn) => ({
            turnId: turn.id,
            status:
              turn.status === "inProgress"
                ? "running"
                : turn.status === "failed"
                  ? "failed"
                  : turn.status === "interrupted"
                    ? "interrupted"
                    : "completed",
            startedAt: turn.startedAt ?? null,
            completedAt: turn.completedAt ?? null,
            preview: turn.messages.at(-1)?.text ?? null,
          })),
          lifecycle,
          lastLifecycleCursor: lifecycle.at(-1)?.cursor ?? null,
          sourcePath: file,
        },
        detail: {
          provider: "pi",
          threadId: thread.threadId,
          preview,
          status:
            status === "running"
              ? "active"
              : status === "idle"
                ? "idle"
                : "notLoaded",
          createdAt: String(header.timestamp ?? ""),
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          turns,
        },
        latest,
      };
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 64_000);
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) =>
      part?.type === "text" && typeof part.text === "string"
        ? [part.text]
        : part?.type === "image"
          ? ["[图片]"]
          : part?.type === "toolCall"
            ? [`[工具调用: ${String(part.name ?? "tool")}]`]
            : [],
    )
    .join("\n")
    .slice(0, 64_000);
}
