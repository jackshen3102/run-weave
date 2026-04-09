import { describe, expect, it, vi } from "vitest";
import { TerminalOutputBatcher } from "./output-batcher";

describe("TerminalOutputBatcher", () => {
  it("flushes the next chunk immediately after interactive input", () => {
    vi.useFakeTimers();
    try {
      const flushed: string[] = [];
      const batcher = new TerminalOutputBatcher((output) => {
        flushed.push(output);
      });

      batcher.markNextChunkInteractive();
      batcher.push("ls");

      expect(flushed).toEqual(["ls"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps batching subsequent chunks after the interactive echo", () => {
    vi.useFakeTimers();
    try {
      const flushed: string[] = [];
      const batcher = new TerminalOutputBatcher((output) => {
        flushed.push(output);
      });

      batcher.markNextChunkInteractive();
      batcher.push("ls");
      batcher.push(" -la");

      expect(flushed).toEqual(["ls"]);

      vi.advanceTimersByTime(16);

      expect(flushed).toEqual(["ls", " -la"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
