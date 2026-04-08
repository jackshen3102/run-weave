import { describe, expect, it } from "vitest";
import {
  containsTerminalActivityContent,
  shouldEmitTerminalActivityPulse,
  shouldMarkTerminalActivity,
} from "./activity-marker";

describe("shouldMarkTerminalActivity", () => {
  it("marks background terminal output after the initial quiet period", () => {
    expect(
      shouldMarkTerminalActivity({
        active: false,
        now: 2_500,
        openedAt: 0,
        lastResizedAt: null,
      }),
    ).toBe(true);
  });

  it("ignores output from the active terminal", () => {
    expect(
      shouldMarkTerminalActivity({
        active: true,
        now: 2_500,
        openedAt: 0,
        lastResizedAt: null,
      }),
    ).toBe(false);
  });

  it("ignores the first second of output after opening", () => {
    expect(
      shouldMarkTerminalActivity({
        active: false,
        now: 900,
        openedAt: 0,
        lastResizedAt: null,
      }),
    ).toBe(false);
  });

  it("ignores output immediately after a resize", () => {
    expect(
      shouldMarkTerminalActivity({
        active: false,
        now: 2_500,
        openedAt: 0,
        lastResizedAt: 1_800,
      }),
    ).toBe(false);
  });
});

describe("containsTerminalActivityContent", () => {
  it("returns true for visible terminal output", () => {
    expect(containsTerminalActivityContent("npm run dev\r\nready")).toBe(true);
  });

  it("returns false for pure control sequences and whitespace", () => {
    expect(
      containsTerminalActivityContent("\u001b[?25h\u001b[0m\r\n\t\u0007"),
    ).toBe(false);
  });
});

describe("shouldEmitTerminalActivityPulse", () => {
  it("emits when no previous pulse exists", () => {
    expect(
      shouldEmitTerminalActivityPulse({
        now: 1_000,
        lastMarkedAt: null,
      }),
    ).toBe(true);
  });

  it("suppresses pulses inside the throttle window", () => {
    expect(
      shouldEmitTerminalActivityPulse({
        now: 1_250,
        lastMarkedAt: 1_000,
      }),
    ).toBe(false);
  });

  it("allows pulses after the throttle window", () => {
    expect(
      shouldEmitTerminalActivityPulse({
        now: 1_500,
        lastMarkedAt: 1_000,
      }),
    ).toBe(true);
  });
});
