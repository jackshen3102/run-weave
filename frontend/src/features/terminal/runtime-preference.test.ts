import { describe, expect, it } from "vitest";
import { resolveNewTerminalRuntimePreference } from "./runtime-preference";

describe("terminal runtime preference", () => {
  it("uses pty for newly-created mobile terminals", () => {
    expect(resolveNewTerminalRuntimePreference("mobile")).toBe("pty");
  });

  it("keeps desktop terminals on automatic runtime selection", () => {
    expect(resolveNewTerminalRuntimePreference("desktop")).toBe("auto");
  });
});
