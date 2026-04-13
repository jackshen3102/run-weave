import { describe, expect, it } from "vitest";
import {
  appendToScrollbackBuffer,
  createScrollbackBuffer,
  readScrollbackBuffer,
  readScrollbackBufferTailLines,
} from "./scrollback-buffer";

describe("scrollback buffer", () => {
  it("keeps appending chunks without copying the full transcript on each write", () => {
    const buffer = createScrollbackBuffer("", 32);

    appendToScrollbackBuffer(buffer, "hello");
    appendToScrollbackBuffer(buffer, " ");
    appendToScrollbackBuffer(buffer, "world");

    expect(readScrollbackBuffer(buffer)).toBe("hello world");
  });

  it("drops the oldest chunks when the byte budget is exceeded", () => {
    const buffer = createScrollbackBuffer("", 10);

    appendToScrollbackBuffer(buffer, "abc");
    appendToScrollbackBuffer(buffer, "def");
    appendToScrollbackBuffer(buffer, "ghijk");

    expect(readScrollbackBuffer(buffer)).toBe("defghijk");
  });

  it("keeps only the tail of an oversized chunk", () => {
    const buffer = createScrollbackBuffer("", 4);

    appendToScrollbackBuffer(buffer, "abcdefgh");

    expect(readScrollbackBuffer(buffer)).toBe("efgh");
  });

  it("trims oversized chunks by utf-8 bytes without splitting characters", () => {
    const buffer = createScrollbackBuffer("", 6);

    appendToScrollbackBuffer(buffer, "A你好");

    expect(readScrollbackBuffer(buffer)).toBe("你好");
  });

  it("reads only the latest lines from chunked scrollback", () => {
    const buffer = createScrollbackBuffer("", 1_024);

    appendToScrollbackBuffer(buffer, "line-1\nline-2");
    appendToScrollbackBuffer(buffer, "\nline-3\nline-4");
    appendToScrollbackBuffer(buffer, "\nline-5");

    expect(readScrollbackBufferTailLines(buffer, 3)).toBe(
      "line-3\nline-4\nline-5",
    );
  });

  it("keeps trailing blank lines when reading a scrollback tail", () => {
    const buffer = createScrollbackBuffer("", 1_024);

    appendToScrollbackBuffer(buffer, "line-1\nline-2\n");

    expect(readScrollbackBufferTailLines(buffer, 1)).toBe("");
    expect(readScrollbackBufferTailLines(buffer, 2)).toBe("line-2\n");
  });
});
