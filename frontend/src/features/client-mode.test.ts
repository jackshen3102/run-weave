import { describe, expect, it } from "vitest";
import { resolveClientMode } from "./client-mode";

describe("resolveClientMode", () => {
  it("keeps Electron on desktop mode", () => {
    expect(
      resolveClientMode({
        viewportWidth: 390,
        coarsePointer: true,
        isElectron: true,
      }),
    ).toBe("desktop");
  });

  it("uses mobile mode for phone-sized viewports", () => {
    expect(
      resolveClientMode({
        viewportWidth: 390,
        coarsePointer: false,
      }),
    ).toBe("mobile");
  });

  it("uses mobile mode for coarse pointer tablets below the tablet limit", () => {
    expect(
      resolveClientMode({
        viewportWidth: 900,
        coarsePointer: true,
      }),
    ).toBe("mobile");
  });

  it("keeps wide desktop viewports on desktop mode", () => {
    expect(
      resolveClientMode({
        viewportWidth: 1280,
        coarsePointer: false,
      }),
    ).toBe("desktop");
  });

  it("allows explicit overrides for debugging", () => {
    expect(
      resolveClientMode({
        viewportWidth: 1280,
        coarsePointer: false,
        override: "mobile",
      }),
    ).toBe("mobile");
    expect(
      resolveClientMode({
        viewportWidth: 390,
        coarsePointer: true,
        override: "desktop",
      }),
    ).toBe("desktop");
  });
});
