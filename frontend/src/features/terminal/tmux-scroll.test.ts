import { describe, expect, it } from "vitest";
import { buildTmuxScrollInput } from "./tmux-scroll";

describe("buildTmuxScrollInput", () => {
  it("returns null for zero deltaY", () => {
    expect(buildTmuxScrollInput(0, 80, 24)).toBeNull();
  });

  it("returns scroll-up sequences for negative deltaY", () => {
    const result = buildTmuxScrollInput(-40, 80, 24);
    expect(result).toBe("\x1b[<64;40;12M");
  });

  it("returns scroll-down sequences for positive deltaY", () => {
    const result = buildTmuxScrollInput(40, 80, 24);
    expect(result).toBe("\x1b[<65;40;12M");
  });

  it("repeats sequences for larger deltas", () => {
    const result = buildTmuxScrollInput(-80, 80, 24);
    expect(result).toBe("\x1b[<64;40;12M\x1b[<64;40;12M");
  });

  it("clamps repetitions to maximum scroll lines per event", () => {
    const result = buildTmuxScrollInput(-1000, 80, 24);
    expect(result).toBe("\x1b[<64;40;12M".repeat(3));
  });

  it("uses correct col and row based on terminal dimensions", () => {
    const result = buildTmuxScrollInput(40, 120, 40);
    expect(result).toBe("\x1b[<65;60;20M");
  });

  it("clamps col and row to minimum of 1", () => {
    const result = buildTmuxScrollInput(40, 1, 1);
    expect(result).toBe("\x1b[<65;1;1M");
  });
});
