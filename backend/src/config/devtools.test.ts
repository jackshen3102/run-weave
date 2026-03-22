import { describe, expect, it } from "vitest";
import { resolveDevtoolsEnabled } from "./devtools";

describe("resolveDevtoolsEnabled", () => {
  it("defaults to enabled when env is missing", () => {
    expect(resolveDevtoolsEnabled({})).toBe(true);
  });

  it("allows explicitly disabling devtools", () => {
    expect(
      resolveDevtoolsEnabled({
        BROWSER_DEVTOOLS_ENABLED: "false",
      }),
    ).toBe(false);
  });

  it("keeps devtools enabled when explicitly set to true", () => {
    expect(
      resolveDevtoolsEnabled({
        BROWSER_DEVTOOLS_ENABLED: "true",
      }),
    ).toBe(true);
  });
});
