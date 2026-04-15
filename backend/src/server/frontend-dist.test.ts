import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFrontendDistDir } from "./frontend-dist";

describe("resolveFrontendDistDir", () => {
  it("uses configured frontend dist directory when provided", () => {
    expect(
      resolveFrontendDistDir({
        cwd: "/repo/backend",
        env: {
          FRONTEND_DIST_DIR: "/app/resources/frontend/dist",
        },
        exists: () => false,
      }),
    ).toBe(path.resolve("/app/resources/frontend/dist"));
  });

  it("falls back to frontend dist near the current working directory", () => {
    const expected = path.resolve("/repo/frontend/dist");

    expect(
      resolveFrontendDistDir({
        cwd: "/repo/backend",
        env: {},
        exists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });
});
