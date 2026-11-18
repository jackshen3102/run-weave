import { createHash, type Hash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { NativeRecordLocation } from "@runweave/shared/session-search";

export interface NativeLineScan {
  file: string;
  handle: FileHandle;
  start: number;
  end: number;
  line: number;
  digest: Hash;
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
  onRow: (row: Record<string, unknown>, location: NativeRecordLocation) => void;
  onIssue: (message: string) => void;
}

/** Reads complete JSONL records only. It never opens, edits or follows a source path. */
export async function scanNativeLines(options: NativeLineScan) {
  const { handle, digest, onRow, onIssue } = options;
  const buffer = Buffer.alloc(256 * 1024);
  let position = options.start, offset = position, line = options.line;
  let committedOffset = position, committedHash = digest.copy().digest("hex");
  let pending = Buffer.alloc(0), discarding = false;
  while (position < options.end) {
    options.signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, options.end - position), position);
    if (!bytesRead) throw new Error("native_source_truncated_during_read");
    options.onBytes?.(bytesRead);
    const chunk = buffer.subarray(0, bytesRead), lastNewline = chunk.lastIndexOf(10);
    if (lastNewline >= 0) {
      committedHash = digest.copy().update(chunk.subarray(0, lastNewline + 1)).digest("hex");
      committedOffset = position + lastNewline + 1;
    }
    digest.update(chunk);
    position += bytesRead;
    const bytes = Buffer.concat([pending, chunk]);
    let start = 0, end: number;
    while ((end = bytes.indexOf(10, start)) !== -1) {
      line++;
      const raw = bytes.subarray(start, end + 1);
      if (!discarding && raw.length > 1) {
        if (raw.length > 16 * 1024 * 1024) onIssue(`${options.file}:${line}: native_line_too_large`);
        else {
          let value: unknown;
          try { value = JSON.parse(raw.toString("utf8")); }
          catch { onIssue(`${options.file}:${line}: native_invalid_json`); }
          if (value !== undefined) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
              onRow(value as Record<string, unknown>, {
                path: options.file, line, byteOffset: offset, byteLength: raw.length,
                sha256: createHash("sha256").update(raw).digest("hex"),
              });
            } else onIssue(`${options.file}:${line}: native_invalid_record`);
          }
        }
      }
      discarding = false;
      offset += raw.length;
      start = end + 1;
    }
    pending = Buffer.from(bytes.subarray(start));
    if (discarding || pending.length > 16 * 1024 * 1024) {
      if (!discarding) onIssue(`${options.file}:${line + 1}: native_line_too_large`);
      discarding = true;
      offset += pending.length;
      pending = Buffer.alloc(0);
    }
  }
  return { offset: committedOffset, line, prefixHash: committedHash, incompleteTail: Boolean(pending.length || discarding) };
}
