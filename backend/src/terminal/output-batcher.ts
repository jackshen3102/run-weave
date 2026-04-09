const OUTPUT_BATCH_DURATION_MS = 16;
const OUTPUT_BATCH_MAX_SIZE = 200 * 1024;

export class TerminalOutputBatcher {
  private bufferedOutput = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private flushNextChunkImmediately = false;

  constructor(private readonly onFlush: (output: string) => void) {}

  markNextChunkInteractive(): void {
    this.flushNextChunkImmediately = true;
  }

  push(chunk: string): void {
    if (!chunk) {
      return;
    }

    if (this.flushNextChunkImmediately) {
      this.flushNextChunkImmediately = false;
      this.flush();
      this.bufferedOutput += chunk;
      this.flush();
      return;
    }

    if (this.bufferedOutput.length + chunk.length >= OUTPUT_BATCH_MAX_SIZE) {
      this.flush();
    }

    this.bufferedOutput += chunk;

    if (this.flushTimer) {
      return;
    }

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
