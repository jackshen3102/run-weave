import { describe, expect, it } from "vitest";
import {
  appendToScrollbackBuffer,
  createScrollbackBuffer,
  readScrollbackBuffer,
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
});
