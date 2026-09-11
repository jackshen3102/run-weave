import { randomUUID } from "node:crypto";
import type {
  TerminalOutputCursor,
  TerminalOutputRange,
  TerminalRecoveryReason,
} from "@runweave/shared/terminal/websocket";

export const RESUME_WINDOW_MS = 60_000;
export const RESUME_MAX_BYTES = 512 * 1024;
export const OUTPUT_FRAME_MAX_BYTES = 64 * 1024;
// A byte limit alone does not bound metadata for many one-character writes.
const RESUME_MAX_FRAMES = 8_192;

export interface TerminalOutputFrame {
  readonly data: string;
  readonly range: Readonly<TerminalOutputRange>;
}

interface RetainedFrame extends TerminalOutputFrame {
  readonly createdAt: number;
}

export type TerminalOutputReplay =
  | {
      ok: true;
      frames: readonly TerminalOutputFrame[];
      cursor: TerminalOutputCursor;
    }
  | { ok: false; reason: TerminalRecoveryReason };

/** Split decoded PTY text without creating an invalid UTF-8 frame boundary. */
export function* splitTerminalOutput(data: string): Generator<string> {
  const bytes = Buffer.from(data, "utf8");
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + OUTPUT_FRAME_MAX_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    yield bytes.toString("utf8", start, end);
    start = end;
  }
}

/** One display stream; neither a pane recorder nor a reconstructed screen. */
export class TerminalOutputRecoveryBuffer {
  private readonly streamId = randomUUID();
  private offset = 0;
  private totalBytes = 0;
  private readonly frames = new Map<number, RetainedFrame>();
  private expiredThrough = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get cursor(): TerminalOutputCursor {
    return { streamId: this.streamId, offset: this.offset };
  }

  get retainedBytes(): number {
    this.prune(this.now());
    return this.totalBytes;
  }

  *append(data: string): Generator<TerminalOutputFrame> {
    const createdAt = this.now();
    this.prune(createdAt);
    for (const part of splitTerminalOutput(data)) {
      const bytes = Buffer.byteLength(part, "utf8");
      const fromOffset = this.offset;
      this.offset += bytes;
      const frame: RetainedFrame = Object.freeze({
        data: part,
        range: Object.freeze({
          streamId: this.streamId,
          fromOffset,
          toOffset: this.offset,
        }),
        createdAt,
      });
      this.frames.set(fromOffset, frame);
      this.totalBytes += bytes;
      this.prune(createdAt);
      yield frame;
    }
  }

  read(cursor: TerminalOutputCursor): TerminalOutputReplay {
    this.prune(this.now());
    if (cursor.streamId !== this.streamId)
      return { ok: false, reason: "stream_changed" };
    if (
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > this.offset
    ) {
      return { ok: false, reason: "cursor_invalid" };
    }
    const firstOffset = this.frames.keys().next().value ?? this.offset;
    if (cursor.offset < firstOffset) {
      return {
        ok: false,
        reason:
          cursor.offset < this.expiredThrough
            ? "cursor_expired"
            : "cursor_evicted",
      };
    }
    if (cursor.offset !== this.offset && !this.frames.has(cursor.offset)) {
      return { ok: false, reason: "cursor_invalid" };
    }
    // Copy only references; a replay cannot grow after the captured head.
    return {
      ok: true,
      cursor: this.cursor,
      frames: Array.from(this.frames.values()).filter(
        (frame) => frame.range.fromOffset >= cursor.offset,
      ),
    };
  }

  /** Only a complete stream prefix can seed a new renderer. Never return a tail. */
  readInitial(): TerminalOutputReplay {
    return this.read({ streamId: this.streamId, offset: 0 });
  }

  private prune(now: number): void {
    for (const [offset, frame] of this.frames) {
      const expired = now - frame.createdAt > RESUME_WINDOW_MS;
      if (
        !expired &&
        this.totalBytes <= RESUME_MAX_BYTES &&
        this.frames.size <= RESUME_MAX_FRAMES
      )
        break;
      this.frames.delete(offset);
      this.totalBytes -= frame.range.toOffset - frame.range.fromOffset;
      if (expired) this.expiredThrough = frame.range.toOffset;
    }
  }
}
