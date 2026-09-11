import { logTerminalPerf } from "./perf-logging";
import type { TerminalOutputRange } from "@runweave/shared/terminal/websocket";
import {
  OUTPUT_FRAME_MAX_BYTES,
  type TerminalOutputFrame,
} from "./output-recovery";

const OUTPUT_BATCH_DURATION_MS = 16;
const OUTPUT_BATCH_MAX_SIZE = 200 * 1024;

export class TerminalOutputBatcher {
  private bufferedOutput = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private flushNextChunkImmediately = false;
  private range?: TerminalOutputRange;

  constructor(
    private readonly onFlush: (
      output: string,
      range?: TerminalOutputRange,
    ) => void,
    private readonly label = "default",
  ) {}

  pushFrame(frame: TerminalOutputFrame): void {
    if (
      this.bufferedOutput &&
      (!this.range ||
        this.range.streamId !== frame.range.streamId ||
        this.range.toOffset !== frame.range.fromOffset ||
        frame.range.toOffset - this.range.fromOffset > OUTPUT_FRAME_MAX_BYTES)
    )
      this.flush();
    this.range = {
      ...frame.range,
      fromOffset: this.range?.fromOffset ?? frame.range.fromOffset,
    };
    this.bufferedOutput += frame.data;
    if (this.flushNextChunkImmediately) {
      this.flushNextChunkImmediately = false;
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(
        () => this.flush(),
        OUTPUT_BATCH_DURATION_MS,
      );
    }
  }

  markNextChunkInteractive(): void {
    this.flushNextChunkImmediately = true;
    logTerminalPerf("terminal.batcher.interactive", {
      label: this.label,
      bufferedLen: this.bufferedOutput.length,
    });
  }

  push(chunk: string): void {
    if (!chunk) {
      return;
    }

    if (this.flushNextChunkImmediately) {
      this.flushNextChunkImmediately = false;
      logTerminalPerf("terminal.batcher.push.immediate", {
        label: this.label,
        chunkLen: chunk.length,
        bufferedLen: this.bufferedOutput.length,
      });
      this.flush();
      this.bufferedOutput += chunk;
      this.flush();
      return;
    }

    if (this.bufferedOutput.length + chunk.length >= OUTPUT_BATCH_MAX_SIZE) {
      logTerminalPerf("terminal.batcher.push.max-size", {
        label: this.label,
        chunkLen: chunk.length,
        bufferedLen: this.bufferedOutput.length,
      });
      this.flush();
    }

    this.bufferedOutput += chunk;

    if (this.flushTimer) {
      return;
    }

    logTerminalPerf("terminal.batcher.schedule", {
      label: this.label,
      bufferedLen: this.bufferedOutput.length,
      delayMs: OUTPUT_BATCH_DURATION_MS,
    });
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, OUTPUT_BATCH_DURATION_MS);
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.bufferedOutput) {
      return;
    }

    const output = this.bufferedOutput;
    const range = this.range;
    this.range = undefined;
    this.bufferedOutput = "";
    logTerminalPerf("terminal.batcher.flush", {
      label: this.label,
      outputLen: output.length,
    });
    this.onFlush(output, range);
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.flushNextChunkImmediately = false;
    this.bufferedOutput = "";
    this.range = undefined;
  }
}
