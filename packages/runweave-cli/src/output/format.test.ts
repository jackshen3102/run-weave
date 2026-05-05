import { describe, expect, it } from "vitest";
import { tailLines } from "./format.js";

describe("tailLines", () => {
  it("returns the requested suffix", () => {
    expect(tailLines("one\ntwo\nthree", 2)).toBe("two\nthree");
  });

  it("returns empty output for non-positive tails", () => {
    expect(tailLines("one\ntwo", 0)).toBe("");
  });

  it("ignores terminal screen padding at the end", () => {
    expect(tailLines("one\ntwo\n\n\n", 2)).toBe("one\ntwo");
  });
});
