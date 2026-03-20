import { describe, expect, it } from "vitest";
import { normalizeRemoteCursor } from "./cursor";

describe("normalizeRemoteCursor", () => {
  it("returns default for empty or auto cursor", () => {
    expect(normalizeRemoteCursor(undefined)).toBe("default");
    expect(normalizeRemoteCursor("auto")).toBe("default");
  });

  it("falls back to default for custom url cursors", () => {
    expect(normalizeRemoteCursor("url(fake.cur), auto")).toBe("default");
  });

  it("passes through supported cursors", () => {
    expect(normalizeRemoteCursor("pointer")).toBe("pointer");
    expect(normalizeRemoteCursor("text")).toBe("text");
  });
});
