import type { ConversationTurn } from "@runweave/shared/terminal/conversation";
import { asRecord, readString } from "../codex/helpers.js";
import { conversationText, isInjectedCodexContext, scanConversationSource } from "../agents/conversation-source.js";
import type { TraeThreadLifecycleReader } from "./lifecycle-reader.js";

/** Project the native history journal, keeping original prose across context compaction. */
export class TraeConversationReader {
  constructor(private readonly paths: TraeThreadLifecycleReader) {}

  async read(threadId: string, signal?: AbortSignal) {
    const file = await this.paths.findThreadPath(threadId);
    if (!file) return null;
    let valid = false;
    let identityMismatch = false;
    let partial = false;
    let turnId: string | null = null;
    let current: ConversationTurn | undefined;
    const turns: ConversationTurn[] = [];
    const seen = new Set<string>();
    const result = await scanConversationSource(file, (record, offset, truncated) => {
      const payload = asRecord(record.payload);
      if (!payload) return;
      if (record.type === "session_meta") {
        identityMismatch ||= payload.id !== threadId;
        valid = payload.id === threadId;
        return;
      }
      if (record.type === "event_msg" && payload.type === "task_started") {
        turnId = readString(payload.turn_id) ?? readString(payload.turnId);
        current = undefined;
        return;
      }
      if (record.type !== "history_mutation") return;
      if (payload.operation === "replace" && readString(payload.compaction_response_id)) {
        // The replacement contains summaries and regenerated IDs, not new visible messages.
        // Original append records remain authoritative, even across repeated compactions.
        if (truncated) partial = true;
        return;
      }
      if (payload.operation !== "append") {
        turns.length = 0;
        seen.clear();
        current = undefined;
        turnId = null;
        if (payload.operation !== "replace") { partial = true; return; }
      }
      if (!Array.isArray(payload.items)) { partial = true; return; }
      const mutationTurnId = readString(payload.turn_id);
      if (mutationTurnId && mutationTurnId !== turnId) {
        turnId = mutationTurnId;
        current = undefined;
      }
      payload.items.forEach((value, index) => {
        const item = asRecord(value);
        if (!item || item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) return;
        if (item.role === "assistant" &&
          ((item.channel != null && !["commentary", "final", "final_answer"].includes(String(item.channel))) ||
           (item.phase != null && !["commentary", "final", "final_answer"].includes(String(item.phase))))) return;
        const text = conversationText(item.content);
        if (!text.trim() || (item.role === "user" && isInjectedCodexContext(text))) return;
        const id = readString(item.id) ?? `record:${offset}:${index}`;
        if (seen.has(id)) return;
        seen.add(id);
        if (item.role === "user" && (!current || current.messages.some(message => message.role === "assistant"))) {
          current = { id, messages: [], ...(turnId ? { rawTurnId: turnId } : {}) };
          turns.push(current);
        }
        if (!current && truncated) {
          current = { id, messages: [], ...(turnId ? { rawTurnId: turnId } : {}) };
          turns.push(current);
        }
        if (!current) return;
        current.messages.push({ id, role: item.role, text,
          ...(turnId ? { rawTurnId: turnId } : {}),
          ...(typeof record.timestamp === "string" ? { createdAt: record.timestamp } : {}),
          ...(item.role === "assistant" && (item.phase ?? item.channel) != null
            ? { phase: (item.phase ?? item.channel) === "commentary" ? "commentary" as const : "final" as const } : {}) });
      });
    }, signal);
    return result && valid && !identityMismatch ? { ...result, partial: result.partial || partial, turns } : null;
  }
}
