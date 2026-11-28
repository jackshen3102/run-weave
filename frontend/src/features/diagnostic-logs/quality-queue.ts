import { QUALITY_LIMITS, type QualityEvent, type QualityRange } from "@runweave/shared/quality-workflow";
export interface QueueState { schemaVersion: 1; backendId: string; sourceId: string; streamId: string; nextSeq: number; events: QualityEvent[]; droppedRanges: QualityRange[]; blocked?: string }
/** Synchronous write before transmission; credentials and endpoints never enter this file. */
export class QualityQueue {
  private state: QueueState;
  readonly key: string;
  constructor(backendId: string) {
    this.key = `runweave.quality.v1.${backendId}`;
    const fresh = (): QueueState => ({ schemaVersion: 1, backendId, sourceId: crypto.randomUUID(), streamId: crypto.randomUUID(), nextSeq: 1, events: [], droppedRanges: [] });
    this.state = fresh();
    const raw = localStorage.getItem(this.key);
    if (raw) {
      try {
        const value = JSON.parse(raw) as QueueState;
        if (value.schemaVersion !== 1 || value.backendId !== backendId || !Array.isArray(value.events) || !Array.isArray(value.droppedRanges) || !Number.isSafeInteger(value.nextSeq) || value.nextSeq < 1 || !value.sourceId || !value.streamId || value.events.some(e => !Number.isSafeInteger(e.seq) || e.seq >= value.nextSeq)) throw new Error("queue_corrupt");
        this.state = value;
      } catch {
        // Preserve the original, rotate stream, disclose corruption as a missing record.
        localStorage.setItem(`${this.key}.corrupt.${crypto.randomUUID()}`, raw);
        this.state.droppedRanges = [{ from: 1, through: 1, reason: "corruption" }]; this.state.nextSeq = 2;
      }
    }
    this.persist();
  }
  snapshot() { const raw = localStorage.getItem(this.key); if (raw) this.state = JSON.parse(raw) as QueueState; return structuredClone(this.state); }
  private persist() { localStorage.setItem(this.key, JSON.stringify(this.state)); }
  private async locked<T>(work: () => T): Promise<T> {
    return navigator.locks.request(this.key, () => {
      const raw = localStorage.getItem(this.key);
      if (raw) this.state = JSON.parse(raw) as QueueState;
      return work();
    });
  }
  enqueue(event: Omit<QualityEvent, "seq">) { return this.locked(() => {
    const next = structuredClone(this.state); next.events.push({ ...event, seq: next.nextSeq++ });
    while (next.events.length > QUALITY_LIMITS.queueEvents || new TextEncoder().encode(JSON.stringify(next)).length > QUALITY_LIMITS.queueBytes) {
      const removed = next.events.shift(); if (!removed) break;
      const range = next.droppedRanges.at(-1);
      if (range?.reason === "overflow" && range.through + 1 === removed.seq) range.through = removed.seq;
      else next.droppedRanges.push({ from: removed.seq, through: removed.seq, reason: "overflow" });
    }
    // A failed write leaves the previous durable queue unchanged and never starts a request.
    localStorage.setItem(this.key, JSON.stringify(next)); this.state = next;
  }); }
  acknowledge(ack: number, sentThrough: number) { return this.locked(() => {
    if (!Number.isSafeInteger(ack) || ack < 0 || ack > Math.max(sentThrough, this.state.nextSeq - 1)) throw new Error("invalid_ack");
    const next = structuredClone(this.state);
    next.events = next.events.filter(e => e.seq > ack); next.droppedRanges = next.droppedRanges.filter(r => r.through > ack).map(r => ({ ...r, from: Math.max(r.from, ack + 1) }));
    localStorage.setItem(this.key, JSON.stringify(next)); this.state = next;
  }); }
  dropRejectedTerminals(terminalSessionIds: string[], fallbackBatchSeqs: number[] = []) { return this.locked(() => {
    const next = structuredClone(this.state);
    if (terminalSessionIds.length > 0) {
      const rejected = new Set(terminalSessionIds);
      const kept: QualityEvent[] = [];
      const droppedSeqs: number[] = [];
      for (const event of next.events) {
        if (event.terminalSessionId && rejected.has(event.terminalSessionId)) droppedSeqs.push(event.seq);
        else kept.push(event);
      }
      if (!droppedSeqs.length) return 0;
      next.events = kept;
      for (const seq of droppedSeqs) next.droppedRanges.push({ from: seq, through: seq, reason: "rejected" });
      next.droppedRanges = mergeRanges(next.droppedRanges);
      localStorage.setItem(this.key, JSON.stringify(next)); this.state = next;
      return droppedSeqs.length;
    }
    const batchSeqs = new Set(fallbackBatchSeqs);
    const kept = next.events.filter(e => !(e.terminalSessionId && batchSeqs.has(e.seq)));
    const removed = next.events.length - kept.length;
    if (!removed) return 0;
    // Older Backends omit terminalSessionIds and predate the "rejected" gap reason;
    // rotate streamId so remaining valid events upload cleanly without sequence gaps.
    next.streamId = crypto.randomUUID();
    next.events = kept.map((event, index) => ({ ...event, seq: index + 1 }));
    next.droppedRanges = [];
    next.nextSeq = next.events.length + 1;
    localStorage.setItem(this.key, JSON.stringify(next)); this.state = next;
    return removed;
  }); }
  block(reason: string) { return this.locked(() => { this.state.blocked = reason; this.persist(); }); }
}

function mergeRanges(ranges: QualityRange[]): QualityRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.through - b.through);
  const merged: QualityRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.reason === range.reason && range.from <= previous.through + 1) {
      previous.through = Math.max(previous.through, range.through);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
