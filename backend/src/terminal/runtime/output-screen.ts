import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import unicode11 from "@xterm/addon-unicode11";
import type { TerminalOutputCursor } from "@runweave/shared/terminal/websocket";
import { RESUME_MAX_BYTES, type TerminalOutputFrame } from "./output-recovery";
import {
  serializeOutputScreen,
  screenParserIsIdle,
} from "./output-screen-state";

export interface TerminalScreenSnapshot {
  data: string;
  cursor: TerminalOutputCursor;
  cols: number;
  rows: number;
}

type Operation =
  | { frame: TerminalOutputFrame }
  | { cols: number; rows: number };

/** A viewport-only mirror of the SAME attach stream, never another tmux client. */
export class TerminalOutputScreen {
  private static pendingSnapshots = 0;
  private readonly terminal = new headless.Terminal({
    cols: 80,
    rows: 24,
    scrollback: 0,
    allowProposedApi: true,
  });
  private readonly serializer = new serialize.SerializeAddon();
  private queue: Operation[] = [];
  private pendingBytes = 0;
  private writing = false;
  private partialControlBytes = 0;
  private disposed = false;
  private cursor: TerminalOutputCursor;
  private snapshotFlight?: Promise<TerminalScreenSnapshot>;
  private completeSnapshot?: () => void;
  private rejectSnapshot?: (error: Error) => void;

  constructor(
    cursor: TerminalOutputCursor,
    private readonly onFailure: () => void,
  ) {
    this.cursor = cursor;
    this.terminal.loadAddon(this.serializer);
    // Match the Web renderer's character widths, including modern emoji.
    this.terminal.loadAddon(new unicode11.Unicode11Addon());
    this.terminal.unicode.activeVersion = "11";
  }

  append(frame: TerminalOutputFrame): void {
    if (this.disposed) return;
    this.pendingBytes += frame.range.toOffset - frame.range.fromOffset;
    if (this.pendingBytes > RESUME_MAX_BYTES || this.queue.length >= 8192) {
      this.dispose();
      this.onFailure();
      return;
    }
    this.queue.push({ frame });
    this.drain();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    // Bound cells as well as output bytes. The PTY uses the same validated grid.
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      rows < 1 ||
      cols > 500 ||
      rows > 200
    ) {
      throw new Error(
        "Terminal size must be within 2..500 columns and 1..200 rows",
      );
    }
    if (this.queue.length >= 8192)
      throw new Error("Terminal resize queue is full");
    this.queue.push({ cols, rows });
    this.drain();
  }

  snapshot(): Promise<TerminalScreenSnapshot> {
    if (this.disposed)
      return Promise.reject(new Error("Terminal mirror unavailable"));
    if (this.snapshotFlight) return this.snapshotFlight;
    if (TerminalOutputScreen.pendingSnapshots >= 2)
      return Promise.reject(new Error("Terminal snapshot capacity reached"));
    TerminalOutputScreen.pendingSnapshots++;
    const flight = new Promise<TerminalScreenSnapshot>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("Terminal snapshot timed out")),
        2000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        this.completeSnapshot = undefined;
        this.rejectSnapshot = undefined;
        if (error) {
          reject(error);
          return;
        }
        try {
          const data = serializeOutputScreen(this.terminal, this.serializer);
          if (Buffer.byteLength(data, "utf8") > RESUME_MAX_BYTES)
            throw new Error("Terminal snapshot exceeds 512 KiB");
          resolve({
            data,
            cursor: { ...this.cursor },
            cols: this.terminal.cols,
            rows: this.terminal.rows,
          });
        } catch (cause) {
          reject(cause);
        }
      };
      this.rejectSnapshot = finish;
      this.completeSnapshot = () => {
        // A partial CSI/OSC/DCS cannot be reconstructed by SerializeAddon. Wait
        // for a real parser boundary; never silently lose its pending prefix.
        if (
          !this.writing &&
          !this.queue.length &&
          screenParserIsIdle(this.terminal)
        )
          finish();
      };
      this.completeSnapshot();
    });
    this.snapshotFlight = flight;
    void flight.then(
      () => {
        TerminalOutputScreen.pendingSnapshots--;
        this.snapshotFlight = undefined;
      },
      () => {
        TerminalOutputScreen.pendingSnapshots--;
        this.snapshotFlight = undefined;
      },
    );
    return flight;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectSnapshot?.(new Error("Terminal mirror disposed"));
    this.queue = [];
    this.pendingBytes = 0;
    this.terminal.dispose();
  }

  private drain(): void {
    if (this.writing || this.disposed) return;
    while (this.queue.length) {
      const operation = this.queue.shift()!;
      if (!("frame" in operation)) {
        this.terminal.resize(operation.cols, operation.rows);
        continue;
      }
      const { frame } = operation;
      this.writing = true;
      this.terminal.write(frame.data, () => {
        if (this.disposed) return;
        this.pendingBytes -= frame.range.toOffset - frame.range.fromOffset;
        this.cursor = {
          streamId: frame.range.streamId,
          offset: frame.range.toOffset,
        };
        this.writing = false;
        this.partialControlBytes = screenParserIsIdle(this.terminal)
          ? 0
          : this.partialControlBytes +
            frame.range.toOffset -
            frame.range.fromOffset;
        if (this.partialControlBytes > RESUME_MAX_BYTES) {
          this.dispose();
          this.onFailure();
          return;
        }
        this.completeSnapshot?.();
        this.drain();
      });
      return;
    }
    this.completeSnapshot?.();
  }
}
