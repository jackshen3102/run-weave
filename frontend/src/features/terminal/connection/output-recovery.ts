import type {
  TerminalOutputCursor,
  TerminalOutputRange,
} from "@runweave/shared/terminal/websocket";

export interface TerminalOutputDelivery {
  commit: (accepted?: boolean) => void;
  cols?: number;
  rows?: number;
}

/** Tracks renderer acceptance, not websocket receipt. Never persists to storage. */
export class TerminalClientOutputRecovery {
  readonly clientId = crypto.randomUUID();
  private committed?: TerminalOutputCursor;
  private received?: TerminalOutputCursor;
  private valid = false;
  private readonly pending: {
    cursor?: TerminalOutputCursor;
    bytes: number;
    done: boolean;
  }[] = [];
  private pendingBytes = 0;
  private readonly settled = new Set<() => void>();

  invalidate(): void {
    this.valid = false;
    this.committed = undefined;
  }

  async reconnectCursor(): Promise<TerminalOutputCursor | undefined> {
    if (this.pending.length)
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          this.settled.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          this.settled.delete(done);
          reject(
            new Error("Terminal renderer has not drained; reconnect paused"),
          );
        }, 2000);
        this.settled.add(done);
      });
    this.received = this.valid ? this.committed : undefined;
    return this.received;
  }

  snapshot(
    data: string,
    cursor?: TerminalOutputCursor,
  ): TerminalOutputDelivery {
    this.invalidate();
    if (
      cursor &&
      (!cursor.streamId ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0)
    )
      throw new Error("Invalid terminal snapshot cursor");
    this.valid = Boolean(cursor);
    this.received = cursor;
    return this.delivery(data, cursor);
  }

  output(data: string, range?: TerminalOutputRange): TerminalOutputDelivery {
    if (!range) {
      this.invalidate();
      this.received = undefined;
      return this.delivery(data);
    }
    const size = new TextEncoder().encode(data).byteLength;
    if (
      !this.received ||
      range.streamId !== this.received.streamId ||
      range.fromOffset !== this.received.offset ||
      !Number.isSafeInteger(range.toOffset) ||
      range.toOffset - range.fromOffset !== size ||
      size > 64 * 1024
    )
      throw new Error("Terminal output discontinuity; reconnect required");
    this.received = { streamId: range.streamId, offset: range.toOffset };
    return this.delivery(data, this.received);
  }

  private delivery(
    data: string,
    cursor?: TerminalOutputCursor,
  ): TerminalOutputDelivery {
    const bytes = new TextEncoder().encode(data).byteLength;
    if (this.pendingBytes + bytes > 1024 * 1024 || this.pending.length >= 8192)
      throw new Error("Terminal renderer output limit; reconnect required");
    const entry = { bytes, cursor, done: false };
    this.pending.push(entry);
    this.pendingBytes += bytes;
    return {
      commit: (accepted = true) => {
        if (entry.done) return;
        if (!accepted) this.invalidate();
        entry.done = true;
        while (this.pending[0]?.done) {
          const first = this.pending.shift()!;
          this.pendingBytes -= first.bytes;
          if (this.valid) this.committed = first.cursor;
        }
        if (!this.pending.length) for (const done of this.settled) done();
      },
    };
  }
}
