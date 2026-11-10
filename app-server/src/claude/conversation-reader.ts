import path from "node:path";
import { formatThreadPreviewText, type AppServerThreadDetail, type AppServerThreadRef } from "@runweave/shared/app-server-events";
import type { ConversationMessage, ConversationTurn } from "@runweave/shared/terminal/conversation";
import { ConversationReadError } from "../agents/conversation-source.js";
import { asRecord, readString } from "../codex/helpers.js";
import type { ClaudeSessionReader } from "./session-reader.js";

type Thread = Pick<AppServerThreadRef, "agent" | "threadId"> & Partial<Pick<AppServerThreadRef, "cwd">>;
type PreservedSegment = { head: string; tail: string; anchor: string };
type Node = { id: string; parent: string | null; type: string; message?: ConversationMessage; userInput?: boolean;
  compactBoundary?: boolean; compactSummary?: boolean; preserved?: PreservedSegment | null };

/** Read-only native Claude projection. Text/stop_reason never establish a settled lifecycle. */
export class ClaudeConversationReader {
  constructor(private readonly sessions: ClaudeSessionReader) {}

  isSourceUnchanged(threadId: string, signature: string): Promise<boolean> {
    return this.sessions.isUnchanged(threadId, signature);
  }

  async read(thread: Thread, signal?: AbortSignal) {
    if (thread.agent !== "claude") return null;
    const nodes = new Map<string, Node>();
    let leaf: string | null = null;
    let valid = false;
    let partial = false;
    const result = await this.sessions.scan(thread.threadId, (record) => {
      const sessionId = readString(record.sessionId);
      if (sessionId && sessionId !== thread.threadId) {
        throw new ConversationReadError(409, "CLAUDE_SESSION_MISMATCH", "Claude 会话身份不匹配");
      }
      // Sidechains and progress carry nested subagent/tool payloads, not the parent conversation.
      if (record.isSidechain === true || record.agentId || record.type === "progress") return;
      // The native last-prompt marker selects a graph leaf, never supplies body text.
      if (record.type === "last-prompt" && sessionId) {
        const selected = readString(record.leafUuid);
        if (selected && selected.length <= 200) leaf = selected;
        return;
      }
      // Claude 2.1.319 links assistant messages through attachment nodes (environment,
      // prompt snapshots, etc.). Retain their parent links, never their rendered content.
      if (!["user", "assistant", "system", "attachment"].includes(String(record.type))) return;
      const id = readString(record.uuid);
      // Some system metadata has no graph identity and cannot move the current leaf.
      if (record.type === "system" && !id) return;
      if (!sessionId || !id || id.length > 200 ||
          (record.parentUuid !== null && typeof record.parentUuid !== "string")) {
        partial = true;
        return;
      }
      const cwd = readString(record.cwd);
      if (thread.cwd && (!cwd || !path.isAbsolute(cwd) || path.resolve(cwd) !== path.resolve(thread.cwd))) {
        throw new ConversationReadError(409, "CLAUDE_SESSION_MISMATCH", "Claude 会话工作目录不匹配");
      }
      valid = true;
      // Native compaction can point logicalParentUuid at an unpersisted command
      // node. Preserve its explicit retained segment for verified graph repair,
      // never guess the most recent message or show the generated summary.
      const compactBoundary = record.type === "system" && record.subtype === "compact_boundary";
      const parent = compactBoundary
        ? readString(record.logicalParentUuid) ?? readString(record.parentUuid)
        : readString(record.parentUuid);
      const node: Node = { id, parent, type: String(record.type),
        compactBoundary, compactSummary: record.isCompactSummary === true,
        ...(compactBoundary ? { preserved: readPreservedSegment(record) } : {}) };
      const message = asRecord(record.message);
      if ((record.type === "user" || record.type === "assistant") && message?.role === record.type &&
          record.isMeta !== true && record.isCompactSummary !== true && record.isVisibleInTranscriptOnly !== true &&
          record.repeatsCompactSummary !== true &&
          !(record.type === "user" && (record.toolUseResult != null || (Array.isArray(message.content) &&
            message.content.some(part => asRecord(part)?.type === "tool_result"))))) {
        const text = visibleText(message.content);
        if (!(record.type === "user" && isNativeCommandEnvelope(text))) {
          // Image-only prompts still begin a turn, without exposing attachment payloads.
          node.userInput = record.type === "user";
          if (text.trim()) node.message = { id, role: record.type, text,
            ...(typeof record.timestamp === "string" ? { createdAt: record.timestamp } : {}) };
        }
      }
      const previous = nodes.get(id);
      if (previous && (previous.parent !== parent || previous.type !== node.type ||
          previous.compactSummary !== node.compactSummary || previous.compactBoundary !== node.compactBoundary ||
          JSON.stringify(previous.preserved) !== JSON.stringify(node.preserved))) {
        throw new ConversationReadError(422, "CLAUDE_TRANSCRIPT_INVALID", "Claude 会话记录存在冲突");
      }
      nodes.set(id, node);
      if (!previous && (record.type !== "system" || record.subtype === "compact_boundary")) leaf = id;
    }, signal);
    if (!result) return null;
    if (!valid) {
      if (result.partial || partial) throw new ConversationReadError(422, "CLAUDE_TRANSCRIPT_INVALID", "Claude 会话记录损坏");
      return null;
    }
    const branch: Node[] = [];
    const seen = new Set<string>();
    let cursor: string | null = leaf;
    while (cursor) {
      if (seen.has(cursor)) throw new ConversationReadError(422, "CLAUDE_TRANSCRIPT_INVALID", "Claude 会话分支存在循环");
      seen.add(cursor);
      const node = nodes.get(cursor);
      if (!node) { partial = true; break; }
      branch.push(node);
      cursor = node.parent;
      if (node.compactBoundary && (!cursor || !nodes.has(cursor))) {
        cursor = retainedParent(node, nodes) ?? cursor;
        if (!cursor) partial = true;
      }
    }
    const turns: ConversationTurn[] = [];
    let current: ConversationTurn | undefined;
    for (const node of branch.reverse()) {
      if (node.userInput || (node.message && !current)) {
        current = { id: node.id, messages: [] };
        turns.push(current);
      }
      if (node.message) current?.messages.push(node.message);
    }
    return { ...result, partial: result.partial || partial, turns };
  }

  async summary(thread: Thread): Promise<AppServerThreadDetail | null> {
    const result = await this.read(thread);
    if (!result) return null;
    return { provider: "claude", id: thread.threadId, status: "unknown",
      preview: formatThreadPreviewText(result.turns.at(-1)?.messages.at(-1)?.text),
      // The shared summary turns require lifecycle status, which transcript text cannot prove.
      turns: [], lifecycle: [], lastLifecycleCursor: null, sourcePath: null };
  }
}

function readPreservedSegment(record: Record<string, unknown>): PreservedSegment | null {
  const metadata = asRecord(record.compactMetadata);
  const segment = asRecord(metadata?.preservedSegment);
  const head = readString(segment?.headUuid), tail = readString(segment?.tailUuid), anchor = readString(segment?.anchorUuid);
  const messages = asRecord(metadata?.preservedMessages);
  if (!head || !tail || !anchor || [head, tail, anchor].some(id => id.length > 200) ||
      (messages && readString(messages.anchorUuid) !== anchor)) return null;
  return { head, tail, anchor };
}

function retainedParent(boundary: Node, nodes: Map<string, Node>): string | null {
  const segment = boundary.preserved;
  if (!segment) return null;
  const summary = nodes.get(segment.anchor);
  if (!summary?.compactSummary || summary.parent !== boundary.id) return null;
  const seen = new Set<string>();
  // Both endpoints must belong to the same existing chain. Missing history
  // (including a bounded-window miss) stays partial instead of borrowing a sibling.
  for (let cursor: string | null = segment.tail; cursor && cursor !== boundary.id && !seen.has(cursor);) {
    seen.add(cursor);
    const node = nodes.get(cursor);
    if (!node) return null;
    if (cursor === segment.head) return segment.tail;
    cursor = node.parent;
  }
  return null;
}

function isNativeCommandEnvelope(text: string): boolean {
  const value = text.trim();
  // Only complete native control envelopes, not inline mentions, code fences or
  // user discussion of these tags. Keep graph nodes but do not render CLI/XML/ANSI.
  if (/^<local-command-(stdout|stderr|caveat)>[\s\S]*<\/local-command-\1>$/.test(value)) return true;
  const prefix = /^<command-name>[^<>\r\n]+<\/command-name>\s*<command-message>/.exec(value);
  const suffix = "</command-args>";
  if (!prefix || !value.endsWith(suffix)) return false;
  // Search once between fixed anchors instead of backtracking over pairs of delimiters.
  return /<\/command-message>\s*<command-args>/.test(value.slice(prefix[0].length, -suffix.length));
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(asRecord).filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part!.text as string).join("\n");
}
