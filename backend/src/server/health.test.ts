import { describe, expect, it } from "vitest";
import { buildHealthPayload } from "./health";

describe("buildHealthPayload", () => {
  it("returns the default health payload when runtime release is absent", () => {
    expect(buildHealthPayload({})).toEqual({ status: "ok" });
  });

  it("includes runtime release id when present", () => {
    expect(
      buildHealthPayload({
        RUNWEAVE_RUNTIME_RELEASE_ID: "manual-a",
      }),
    ).toEqual({
      status: "ok",
      runtimeReleaseId: "manual-a",
    });
  });
});
