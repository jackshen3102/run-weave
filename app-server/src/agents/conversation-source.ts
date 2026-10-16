import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "../codex/helpers.js";

export class ConversationReadError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Scan only complete records in the length captured at open; never retain a source cache. */
export async function scanConversationSource(
  file: string,
  consume: (record: Record<string, unknown>, offset: number, truncated: boolean) => void,
  signal?: AbortSignal,
): Promise<{ partial: boolean; truncated: boolean } | null> {
  if (!path.isAbsolute(file) || path.extname(file) !== ".jsonl") return null;
  let handle;
  try {
    if (await realpath(file) !== file) return null;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const windowBytes = 64 * 1024 * 1024;
    const truncated = stat.size > windowBytes;
    let partial = truncated;
    const chunk = Buffer.alloc(256 * 1024);
    // Keep the authoritative header even when older records are outside the window.
    const ranges = truncated
      ? [{ start: 0, end: Math.min(chunk.length, stat.size), header: true },
        { start: stat.size - windowBytes, end: stat.size, header: false }]
      : [{ start: 0, end: stat.size, header: false }];
    for (const range of ranges) {
      let position = range.start;
      let lineOffset = position;
      let pending = Buffer.alloc(0);
      let skipBoundary = range.start > 0;
      while (position < range.end) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, range.end - position), position);
        if (!bytesRead) { partial = true; break; }
        position += bytesRead;
        const bytes = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let start = 0;
        let end: number;
        let headerRead = false;
        while ((end = bytes.indexOf(10, start)) !== -1) {
          if (!skipBoundary) {
            const line = bytes.subarray(start, end).toString("utf8");
            let record: Record<string, unknown> | null = null;
            if (line.trim()) {
              try { record = asRecord(JSON.parse(line)); }
              catch { partial = true; }
              if (!record) partial = true;
            }
            // Consumer errors must not be mistaken for corrupt JSON.
            if (record) consume(record, lineOffset, truncated);
          }
          skipBoundary = false;
          lineOffset += end - start + 1;
          start = end + 1;
          if (range.header) { headerRead = true; break; }
        }
        if (headerRead) break;
        // Discard the cut record without retaining a potentially huge tool/image payload.
        if (skipBoundary) { lineOffset += bytes.length - start; pending = Buffer.alloc(0); }
        else pending = Buffer.from(bytes.subarray(start));
      }
    }
    signal?.throwIfAborted();
    return { partial, truncated };
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export function conversationText(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map(asRecord).filter((part) => part && ["text", "input_text", "output_text"].includes(String(part.type)))
      .map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
    : "";
  return text.replace(/\s*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/, "");
}

/** Exact standalone envelopes observed in Codex sources; ordinary quoted/user prose stays intact. */
export function isInjectedCodexContext(text: string): boolean {
  const value = text.trim();
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(value) ||
    /^<skill>\s*<name>[\w.:-]+<\/name>\s*<path>[^<>\r\n]+[/\\]SKILL\.md<\/path>(?:(?!<\/?skill>)[\s\S])*<\/skill>$/.test(value) ||
    (/^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n/.test(value) &&
      value.includes("<INSTRUCTIONS>") && value.includes("</INSTRUCTIONS>") &&
      /<environment_context>[\s\S]*<\/environment_context>$/.test(value));
}
