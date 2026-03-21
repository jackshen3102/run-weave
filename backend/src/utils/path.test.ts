import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHomePath, resolveStoragePaths } from "./path";

describe("path helpers", () => {
  it("expands a leading home directory token", () => {
    expect(expandHomePath("~/data/session.db", "/Users/tester")).toBe(
      path.join("/Users/tester", "data", "session.db"),
    );
  });

  it("resolves default storage paths under the home directory", () => {
    expect(resolveStoragePaths({}, "/Users/tester")).toEqual({
      browserProfileDir: path.join("/Users/tester", ".browser-profile"),
      sessionDbFile: path.join(
        "/Users/tester",
        ".browser-profile",
        "session-store.db",
      ),
    });
  });

  it("derives the default database path from an overridden profile directory", () => {
    expect(
      resolveStoragePaths(
        { BROWSER_PROFILE_DIR: "~/custom-profile", SESSION_DB_FILE: "   " },
        "/Users/tester",
      ),
    ).toEqual({
      browserProfileDir: path.join("/Users/tester", "custom-profile"),
      sessionDbFile: path.join(
        "/Users/tester",
        "custom-profile",
        "session-store.db",
      ),
    });
  });

  it("expands explicit database paths independently", () => {
    expect(
      resolveStoragePaths(
        {
          BROWSER_PROFILE_DIR: "~/custom-profile",
          SESSION_DB_FILE: "~/db/session.db",
        },
        "/Users/tester",
      ),
    ).toEqual({
      browserProfileDir: path.join("/Users/tester", "custom-profile"),
      sessionDbFile: path.join("/Users/tester", "db", "session.db"),
    });
  });
});
