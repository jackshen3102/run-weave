import type { ConversationTurn } from "@runweave/shared/terminal/conversation";
import { asRecord, readString } from "./helpers.js";
import type { CodexRolloutLifecycleReader } from "./lifecycle-reader.js";
import { conversationText, isInjectedCodexContext, scanConversationSource } from "../agents/conversation-source.js";

export class CodexConversationReader {
  constructor(private readonly paths: CodexRolloutLifecycleReader) {}

  async read(threadId: string, signal?: AbortSignal) {
    const file = await this.paths.findThreadPath(threadId);
    if (!file) return null;
    let valid = false;
    let identityMismatch = false;
    let turnId: string | null = null;
    let current: ConversationTurn | undefined;
    const turns: ConversationTurn[] = [];
    const seen = new Set<string>();
    const result = await scanConversationSource(file, (record, offset) => {
      const item = asRecord(record.payload);
      if (!item) return;
      if (record.type === "session_meta") {
        identityMismatch ||= item.id !== threadId;
        valid = item.id === threadId;
        return;
      }
      if (record.type === "event_msg" && item.type === "task_started") {
        turnId = readString(item.turn_id) ?? readString(item.turnId);
        current = undefined;
        return;
      }
      if (record.type !== "response_item" || item.type !== "message") return;
      if (item.role !== "user" && item.role !== "assistant") return;
      if (item.role === "assistant" &&
        ((item.channel != null && !["commentary", "final", "final_answer"].includes(String(item.channel))) ||
         (item.phase != null && !["commentary", "final", "final_answer"].includes(String(item.phase))))) return;
      const text = conversationText(item.content);
      if (!text.trim() || (item.role === "user" && isInjectedCodexContext(text))) return;
      const id = readString(item.id) ?? `record:${offset}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (item.role === "user") {
        // Several steered user messages can belong to one running turn.
        if (!current || current.messages.some((message) => message.role === "assistant")) {
          current = { id: turnId ? `${turnId}:${id}` : id, messages: [] };
          turns.push(current);
        }
      }
      if (!current) return;
      current.messages.push({ id, role: item.role, text,
        ...(typeof record.timestamp === "string" ? { createdAt: record.timestamp } : {}) });
    }, signal);
    return result && valid && !identityMismatch ? { ...result, turns } : null;
  }
}
