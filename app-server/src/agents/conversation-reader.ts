import type { AppServerThreadRef } from "@runweave/shared/app-server-events";
import type { AppServerConversationResponse } from "@runweave/shared/terminal/conversation";
import type { CodexConversationReader } from "../codex/conversation-reader.js";
import type { PiSessionReader } from "../pi/session-reader.js";
import { ConversationReadError } from "./conversation-source.js";

export class ConversationReader {
  constructor(private readonly codex: CodexConversationReader, private readonly pi: PiSessionReader) {}

  async read(thread: AppServerThreadRef, signal?: AbortSignal): Promise<AppServerConversationResponse> {
    const supported = thread.agent === "codex" || thread.agent === "pi";
    const content = thread.agent === "codex" ? await this.codex.read(thread.threadId, signal)
      : thread.agent === "pi" ? await this.pi.readConversation(thread, signal) : null;
    const response: AppServerConversationResponse = {
      threadId: thread.threadId, provider: thread.agent,
      availability: !supported ? "provider_unsupported" : content ? "available" : "source_missing",
      readAt: new Date().toISOString(), partial: content?.partial ?? false, turns: content?.turns ?? [],
    };
    if (Buffer.byteLength(JSON.stringify(response)) > 8 * 1024 * 1024)
      throw new ConversationReadError(413, "CONVERSATION_TOO_LARGE", "会话正文超过读取上限");
    return response;
  }
}
