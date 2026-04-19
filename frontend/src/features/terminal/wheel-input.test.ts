import { describe, expect, it } from "vitest";
import { shouldSuppressWheelInput } from "./wheel-input";

describe("terminal wheel input", () => {
  function wheelEvent(params: {
    deltaY?: number;
    shiftKey?: boolean;
  }): Pick<WheelEvent, "deltaY" | "shiftKey"> {
    return {
      deltaY: params.deltaY ?? 120,
      shiftKey: params.shiftKey ?? false,
    };
  }

  it("suppresses vertical wheel input when terminal scrollback cannot scroll", () => {
    expect(shouldSuppressWheelInput(wheelEvent({}), false)).toBe(true);
  });

  it("allows wheel input when terminal scrollback can scroll", () => {
    expect(shouldSuppressWheelInput(wheelEvent({}), true)).toBe(false);
  });

  it("ignores horizontal-only or shift wheel events", () => {
    expect(shouldSuppressWheelInput(wheelEvent({ deltaY: 0 }), false)).toBe(false);
    expect(shouldSuppressWheelInput(wheelEvent({ shiftKey: true }), false)).toBe(
      false,
    );
  });
});
