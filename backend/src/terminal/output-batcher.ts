import { logTerminalPerf } from "./perf-logging";

const OUTPUT_BATCH_DURATION_MS = 16;
const OUTPUT_BATCH_MAX_SIZE = 200 * 1024;

export class TerminalOutputBatcher {
  private bufferedOutput = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private flushNextChunkImmediately = false;

  constructor(
    private readonly onFlush: (output: string) => void,
    private readonly label = "default",
  ) {}

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
    this.bufferedOutput = "";
    logTerminalPerf("terminal.batcher.flush", {
      label: this.label,
      outputLen: output.length,
    });
    this.onFlush(output);
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.flushNextChunkImmediately = false;
    this.bufferedOutput = "";
  }
}
