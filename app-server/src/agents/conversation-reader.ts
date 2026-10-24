import type { SupervisionConversationReader } from "./supervision-reader.js";
import type { AppServerThreadRef } from "@runweave/shared/app-server-events";
import type { AppServerConversationResponse, ConversationTurn } from "@runweave/shared/terminal/conversation";
import type { CodexConversationReader } from "../codex/conversation-reader.js";
import type { PiSessionReader } from "../pi/session-reader.js";
import type { TraeConversationReader } from "../trae/conversation-reader.js";
import { ConversationReadError } from "./conversation-source.js";

export class ConversationReader {
  constructor(private readonly codex: CodexConversationReader, private readonly pi: PiSessionReader, private readonly trae: TraeConversationReader, private readonly supervision?: SupervisionConversationReader) {}

  async readSupervision(thread: AppServerThreadRef | { agent: "codex"; threadId: string }, requiredIds: string[]) {
    if (thread.agent !== "codex") return { ...await this.read(thread), indexing: false };
    if (!this.supervision) throw new ConversationReadError(503, "SUPERVISION_READER_UNAVAILABLE", "监控读取服务尚未初始化");
    return this.supervision.read(thread.threadId, requiredIds);
  }

  // Codex and Trae verify controlled sources; Pi needs its registered file context.
  async read(thread: Pick<AppServerThreadRef, "agent" | "threadId" | "pi">, signal?: AbortSignal): Promise<AppServerConversationResponse> {
    const isTrae = ["trae", "traecli", "traex"].includes(thread.agent);
    const supported = thread.agent === "codex" || thread.agent === "pi" || isTrae;
    const content = thread.agent === "codex" ? await this.codex.read(thread.threadId, signal)
      : thread.agent === "pi" ? await this.pi.readConversation(thread, signal)
      : isTrae ? await this.trae.read(thread.threadId, signal) : null;
    const response: AppServerConversationResponse = {
      threadId: thread.threadId, provider: thread.agent,
      availability: !supported ? "provider_unsupported" : content ? "available" : "source_missing",
      readAt: new Date().toISOString(), partial: content?.partial ?? false, turns: content?.turns ?? [],
    };
    return recentConversation(response);
  }
}

/** Keep recent messages within the transport budget, including JSON escaping and metadata. */
function recentConversation(response: AppServerConversationResponse): AppServerConversationResponse {
  // Leave room for the Backend's terminal/panel target envelope.
  const limit = 8 * 1024 * 1024 - 2048;
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  let remaining = limit - size({ ...response, partial: true, turns: [] });
  const sizes = response.turns.map((turn) => size(turn) + 1);
  if (sizes.reduce((sum, bytes) => sum + bytes, 0) <= remaining) return response;
  const turns: ConversationTurn[] = [];
  for (let index = response.turns.length - 1; index >= 0; index--) {
    const turn = response.turns[index]!;
    if (sizes[index]! <= remaining) {
      turns.push(turn);
      remaining -= sizes[index]!;
      continue;
    }
    remaining -= size({ ...turn, messages: [] }) + 1;
    const messages: ConversationTurn["messages"] = [];
    for (let m = turn.messages.length - 1; m >= 0; m--) {
      const message = turn.messages[m]!;
      const bytes = size(message) + 1;
      if (bytes <= remaining) {
        messages.push(message);
        remaining -= bytes;
        continue;
      }
      // A single oversized answer must not hide all of the latest conversation.
      let low = 0;
      let high = message.text.length;
      while (low < high) {
        const length = Math.ceil((low + high) / 2);
        if (size({ ...message, text: message.text.slice(-length) }) + 1 <= remaining) low = length;
        else high = length - 1;
      }
      if (low) {
        let text = message.text.slice(-low);
        if (/^[\uDC00-\uDFFF]/u.test(text)) text = text.slice(1);
        if (text) messages.push({ ...message, text });
      }
      break;
    }
    if (messages.length) turns.push({ ...turn, messages: messages.reverse() });
    break;
  }
  return { ...response, partial: true, turns: turns.reverse() };
}
