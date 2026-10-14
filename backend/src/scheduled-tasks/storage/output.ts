import type Database from "better-sqlite3";
import { parseRun, type StoredRow } from "./validation";
import type { ScheduledOutputChunk } from "./worker-protocol";

// Borrow the connection; own output content, byte pagination and cursor updates.
export function appendScheduledOutput(
  database: Database.Database,
  runId: string,
  text: string,
  maxBytes: number,
): boolean {
  const content = Buffer.from(text, "utf8");
  // Serialize the size check and append across worker connections; never read old bodies.
  return database
    .transaction(() => {
      const run = requireRun(database, runId);
      const end = outputBytes(database, runId) + content.byteLength;
      if (end > maxBytes) return false;
      if (content.byteLength) {
        database
          .prepare(
            "INSERT INTO scheduled_run_output_chunks(run_id, end_byte, content) VALUES (?, ?, ?)",
          )
          .run(runId, end, content);
      }
      database
        .prepare("UPDATE scheduled_runs SET payload_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...run, outputCursor: String(end) }), runId);
      return true;
    })
    .immediate();
}

export function readScheduledOutput(
  database: Database.Database,
  runId: string,
  offset: number,
  maxBytes: number,
): ScheduledOutputChunk {
  // Length and range must come from the same snapshot if another connection appends.
  return database.transaction(() => {
    requireRun(database, runId);
    const totalBytes = outputBytes(database, runId);
    const safeOffset = Math.min(Math.max(0, offset), totalBytes);
    if (safeOffset === totalBytes)
      return { text: "", nextOffset: safeOffset, totalBytes };
    // Keep a UTF-8 character's leading bytes even for a caller-supplied mid-character cursor.
    const start = Math.max(0, safeOffset - 3);
    const prefix = safeOffset - start;
    const rangeEnd = Math.min(totalBytes, safeOffset + maxBytes + 4);
    const rows = database
      .prepare(
        `SELECT substr(content,
          max(1, @start - end_byte + length(content) + 1),
          min(end_byte, @end) - max(end_byte - length(content), @start)) AS bytes
         FROM scheduled_run_output_chunks
         WHERE run_id = @runId AND end_byte > @start ORDER BY end_byte`,
      )
      .iterate({ runId, start, end: rangeEnd }) as IterableIterator<{
      bytes: Buffer;
    }>;
    const chunks: Buffer[] = [];
    let length = 0;
    for (const row of rows) {
      chunks.push(row.bytes);
      length += row.bytes.byteLength;
      // Stop the indexed scan as soon as the requested range is complete.
      if (length >= rangeEnd - start) break;
    }
    const bytes = Buffer.concat(chunks, length);
    const end = safeUtf8End(
      bytes,
      Math.min(bytes.byteLength, prefix + maxBytes),
    );
    return {
      text: bytes.subarray(prefix, end).toString("utf8"),
      nextOffset: start + end,
      totalBytes,
    };
  })();
}

function outputBytes(database: Database.Database, runId: string): number {
  const row = database
    .prepare(
      "SELECT end_byte FROM scheduled_run_output_chunks WHERE run_id = ? ORDER BY end_byte DESC LIMIT 1",
    )
    .get(runId) as { end_byte: number } | undefined;
  return row?.end_byte ?? 0;
}

function requireRun(database: Database.Database, runId: string) {
  const row = database
    .prepare("SELECT * FROM scheduled_runs WHERE id = ?")
    .get(runId) as StoredRow | undefined;
  if (!row) throw new Error("scheduled_run_not_found");
  return parseRun(row);
}

function safeUtf8End(buffer: Buffer, proposedEnd: number): number {
  if (proposedEnd >= buffer.byteLength) return buffer.byteLength;
  let lead = proposedEnd;
  while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead === proposedEnd) return proposedEnd;
  const byte = buffer[lead]!;
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return lead + width <= proposedEnd ? proposedEnd : lead;
}
