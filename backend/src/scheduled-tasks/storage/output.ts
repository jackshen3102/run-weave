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
  const existing = database
    .prepare("SELECT content FROM scheduled_run_output WHERE run_id = ?")
    .get(runId) as { content: string } | undefined;
  requireRun(database, runId);
  const content = `${existing?.content ?? ""}${text}`;
  if (Buffer.byteLength(content) > maxBytes) return false;
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO scheduled_run_output(run_id, content) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET content = excluded.content`,
      )
      .run(runId, content);
    const run = requireRun(database, runId);
    const next = {
      ...run,
      outputCursor: String(Buffer.byteLength(content)),
    };
    database
      .prepare("UPDATE scheduled_runs SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(next), runId);
  })();
  return true;
}

export function readScheduledOutput(
  database: Database.Database,
  runId: string,
  offset: number,
  maxBytes: number,
): ScheduledOutputChunk {
  requireRun(database, runId);
  const row = database
    .prepare("SELECT content FROM scheduled_run_output WHERE run_id = ?")
    .get(runId) as { content: string } | undefined;
  const buffer = Buffer.from(row?.content ?? "", "utf8");
  const safeOffset = Math.min(Math.max(0, offset), buffer.byteLength);
  const end = safeUtf8End(
    buffer,
    Math.min(buffer.byteLength, safeOffset + maxBytes),
  );
  return {
    text: buffer.subarray(safeOffset, end).toString("utf8"),
    nextOffset: end,
    totalBytes: buffer.byteLength,
  };
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
