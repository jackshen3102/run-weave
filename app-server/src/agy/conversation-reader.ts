import {
  formatThreadPreviewText,
  type AppServerThreadDetail,
  type AppServerThreadRef,
} from "@runweave/shared/app-server-events";
import type { ConversationTurn } from "@runweave/shared/terminal/conversation";
import { readString } from "../codex/helpers.js";
import type { AgySessionReader } from "./session-reader.js";

type Thread = Pick<AppServerThreadRef, "agent" | "threadId"> &
  Partial<Pick<AppServerThreadRef, "cwd">>;

export function extractAgyUserText(raw: string): string {
  const userRequestMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(raw);
  const base = userRequestMatch ? userRequestMatch[1]! : raw;
  return base
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

/** Read-only native AGY projection from transcript.jsonl. */
export class AgyConversationReader {
  constructor(private readonly sessions: AgySessionReader) {}

  isSourceUnchanged(threadId: string, signature: string): Promise<boolean> {
    return this.sessions.isUnchanged(threadId, signature);
  }

  async read(thread: Thread, signal?: AbortSignal) {
    if (thread.agent !== "agy") return null;
    const turns: ConversationTurn[] = [];
    let current: ConversationTurn | undefined;
    let index = 0;
    const result = await this.sessions.scan(
      thread.threadId,
      (record) => {
        index += 1;
        const source = readString(record.source);
        const type = readString(record.type);
        if (source === "SYSTEM" || type === "SYSTEM_MESSAGE") return;
        const id = readString(record.id) ?? `${thread.threadId}:${index}`;
        const createdAt = readString(record.timestamp);

        if (source === "USER_EXPLICIT" && type === "USER_INPUT") {
          const raw = readString(record.content) ?? "";
          const text = extractAgyUserText(raw);
          current = { id, messages: [] };
          turns.push(current);
          if (text) {
            current.messages.push({
              id,
              role: "user",
              text,
              ...(createdAt ? { createdAt } : {}),
            });
          }
          return;
        }

        if (source === "MODEL" && type === "PLANNER_RESPONSE") {
          const text = readString(record.content)?.trim();
          if (!text) return;
          if (!current) {
            current = { id, messages: [] };
            turns.push(current);
          }
          current.messages.push({
            id,
            role: "assistant",
            text,
            ...(createdAt ? { createdAt } : {}),
          });
        }
      },
      signal,
      thread.cwd,
    );
    if (!result) return null;
    return { ...result, turns };
  }

  async summary(thread: Thread): Promise<AppServerThreadDetail | null> {
    const result = await this.read(thread);
    if (!result) return null;
    return {
      provider: "agy",
      id: thread.threadId,
      status: "unknown",
      preview: formatThreadPreviewText(result.turns.at(-1)?.messages.at(-1)?.text),
      turns: [],
      lifecycle: [],
      lastLifecycleCursor: null,
      sourcePath: null,
    };
  }
}
