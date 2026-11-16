import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { QualityBatch, QualityEvent } from "@runweave/shared/quality-workflow";
import type { QualityStore } from "./store";
/** Reads only the configured host's backend log directory. Never opens device exports. */
export class QualityLogReader {
  constructor(private store: QualityStore, private backendId: string, private directory: string, private projectForTerminal: (id: string) => string | null | undefined, private kind: "backend" | "desktop" = "backend") {}
  async poll(): Promise<void> {
    const offsets = await this.store.offsets();
    let files: string[];
    try { files = (await readdir(this.directory)).filter(f => this.kind === "backend" ? /^backend-.*\.jsonl$/.test(f) : /^events\.jsonl(?:\.1)?$/.test(f)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
    const prefix = `${this.kind}-${createHash("sha256").update(this.directory).digest("hex").slice(0, 16)}-`;
    const observed = new Set<string>();
    for (const file of files) {
      const full = path.join(this.directory, file); const info = await stat(full);
      if (!info.isFile()) continue;
      const baseIdentity = `${info.dev}-${info.ino}-${info.birthtimeMs}`;
      const key = prefix + createHash("sha256").update(baseIdentity).digest("hex");
      observed.add(key);
      const previous = offsets[key];
      let identity = previous?.identity.startsWith(baseIdentity) ? previous.identity : baseIdentity;
      let offset = previous?.identity === identity ? previous.offset : 0;
      let gap: string | undefined = previous && previous.identity !== identity ? "log_rotated" : undefined;
      if (info.size < offset) { offset = 0; identity = `${baseIdentity}-${Date.now()}`; gap = "log_truncated"; }
      if (info.size === offset && !gap && !previous?.missing) continue;
      const handle = await open(full, "r");
      try {
        const buffer = Buffer.alloc(Math.min(256 * 1024, info.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const bytes = buffer.subarray(0, bytesRead); let consumed = 0;
        const events: QualityEvent[] = []; const projects: Record<string, string | null> = {};
        let seq = offset + 1;
        // Log seq advances by records, not wall time. Persist position and seq in the same transaction.
        const streamId = createHash("sha256").update(`${key}:${identity}`).digest("hex");
        const sourceId = `${this.kind}-logs-${this.backendId.slice(0, 32)}`;
        const coverage = await this.store.coverage();
        seq = (coverage.sources.find(s => s.sourceId === sourceId && s.streamId === streamId)?.ackThrough ?? 0) + 1;
        for (let start = 0; start < bytes.length && events.length < 64;) {
          const end = bytes.indexOf(10, start); if (end < 0) break;
          consumed = end + 1;
          try {
            const raw = JSON.parse(bytes.subarray(start, end).toString("utf8"));
            const event = fromLog(raw, seq, `${streamId}-${offset + start}`, this.kind);
            if (event) {
              if (event.terminalSessionId) projects[event.terminalSessionId] = this.projectForTerminal(event.terminalSessionId) ?? null;
              events.push(event); seq++;
            }
          } catch { gap = "log_parse_failed"; }
          start = end + 1;
        }
        if (!consumed && bytesRead === 256 * 1024) { consumed = bytesRead; gap = "log_record_oversized"; }
        const batch: QualityBatch = { schemaVersion: 1, backendId: this.backendId, sourceId, streamId, client: "backend", uploadedAt: new Date().toISOString(), events, droppedRanges: [] };
        await this.store.ingest(batch, projects, { key, identity, offset: offset + consumed, gap });
      } finally { await handle.close(); }
    }
    for (const key of Object.keys(offsets)) {
      if (key.startsWith(prefix) && !observed.has(key)) {
        const previous = offsets[key];
        if (previous?.missing) continue;
        await this.store.ingest({ schemaVersion: 1, backendId: this.backendId, sourceId: `${this.kind}-logs-${this.backendId.slice(0, 32)}`, streamId: key, client: "backend", uploadedAt: new Date().toISOString(), events: [], droppedRanges: [] }, {}, { key, identity: previous!.identity, offset: previous!.offset, missing: true, gap: "log_missing" });
      }
    }
  }
}
function fromLog(raw: Record<string, unknown>, seq: number, position: string, kind: "backend" | "desktop"): QualityEvent | null {
  if (!raw || typeof raw !== "object" || typeof raw.event !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(raw.event)) return null;
  if (kind === "desktop" && !["main.stalled", "renderer.unresponsive", "renderer.probeFailed", "renderer.gone", "observer.gap"].includes(raw.event)) return null;
  const correlated = kind === "backend" && raw.event.startsWith("terminal.input.") && typeof raw.operationId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.operationId);
  if (kind === "backend" && !correlated && raw.level !== "error" && raw.level !== "warn") return null;
  if (raw.event.startsWith("quality.")) return null;
  const identifier = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v) ? v : undefined;
  const terminalSessionId = identifier(raw.terminalSessionId);
  return { seq, at: typeof (raw.timestamp ?? raw.at) === "string" && Number.isFinite(Date.parse((raw.timestamp ?? raw.at) as string)) ? new Date((raw.timestamp ?? raw.at) as string).toISOString() : new Date().toISOString(),
    action: correlated ? "terminal_send" : kind === "backend" ? "backend_incident" : "desktop_incident", stage: raw.event === "terminal.input.accepted" ? "confirmed" : raw.event === "terminal.input.requested" ? "request_started" : "failed",
    operationId: correlated ? raw.operationId as string : createHash("sha256").update(position).digest("hex"),
    launchId: identifier(raw.launchId) ?? "log-source", elapsedMs: typeof raw.durationMs === "number" && Number.isSafeInteger(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : 0,
    // Rolling files can contain older builds. Never label historical lines with the reader's build.
    appVersion: "unknown", buildId: "unknown", sourceRevision: "unknown", sourceState: "unknown",
    ...(terminalSessionId ? { terminalSessionId } : {}), ...(identifier(raw.attemptId) ? { attemptId: identifier(raw.attemptId) } : {}),
    failureCode: raw.event.toUpperCase().replace(/[.-]/g, "_"),
  };
}
