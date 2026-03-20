import { describe, expect, it } from "vitest";
import {
  buildCopyEventPayload,
  isCopyOrCutShortcut,
  truncateClipboardText,
} from "./clipboard";

describe("clipboard helpers", () => {
  it("detects copy and cut shortcuts", () => {
    expect(
      isCopyOrCutShortcut({
        type: "keyboard",
        key: "c",
        modifiers: ["Control"],
      }),
    ).toBe(true);
    expect(
      isCopyOrCutShortcut({
        type: "keyboard",
        key: "x",
        modifiers: ["Meta"],
      }),
    ).toBe(true);
    expect(
      isCopyOrCutShortcut({
        type: "keyboard",
        key: "a",
        modifiers: ["Control"],
      }),
    ).toBe(false);
  });

  it("truncates clipboard payload to safe length", () => {
    const text = "a".repeat(10);
    expect(truncateClipboardText(text, 5)).toBe("aaaaa");
  });

  it("builds clipboard copy event payload", () => {
    expect(buildCopyEventPayload("hello")).toEqual({
      type: "clipboard",
      action: "copy",
      text: "hello",
    });
  });
});
