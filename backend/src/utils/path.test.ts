import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHomePath, resolveStoragePaths } from "./path";

describe("path helpers", () => {
  it("expands a leading home directory token", () => {
    expect(expandHomePath("~/data/session.json", "/Users/tester")).toBe(
      path.join("/Users/tester", "data", "session.json"),
    );
  });

  it("resolves default storage paths under the home directory", () => {
    expect(resolveStoragePaths({}, "/Users/tester")).toEqual({
      browserProfileDir: path.join("/Users/tester", ".browser-profile"),
      sessionStoreFile: path.join(
        "/Users/tester",
        ".browser-profile",
        "session-store.json",
      ),
      terminalSessionStoreFile: path.join(
        "/Users/tester",
        ".browser-profile",
        "terminal-session-store.json",
      ),
    });
  });

  it("derives the default store path from an overridden profile directory", () => {
    expect(
      resolveStoragePaths(
        { BROWSER_PROFILE_DIR: "~/custom-profile", SESSION_STORE_FILE: "   " },
        "/Users/tester",
      ),
    ).toEqual({
      browserProfileDir: path.join("/Users/tester", "custom-profile"),
      sessionStoreFile: path.join(
        "/Users/tester",
        "custom-profile",
        "session-store.json",
      ),
      terminalSessionStoreFile: path.join(
        "/Users/tester",
        "custom-profile",
        "terminal-session-store.json",
      ),
    });
  });

  it("expands explicit store paths independently", () => {
    expect(
      resolveStoragePaths(
        {
          BROWSER_PROFILE_DIR: "~/custom-profile",
          SESSION_STORE_FILE: "~/db/session.json",
          TERMINAL_SESSION_STORE_FILE: "~/db/terminal-session.json",
        },
        "/Users/tester",
      ),
    ).toEqual({
      browserProfileDir: path.join("/Users/tester", "custom-profile"),
      sessionStoreFile: path.join("/Users/tester", "db", "session.json"),
      terminalSessionStoreFile: path.join(
        "/Users/tester",
        "db",
        "terminal-session.json",
      ),
    });
  });
});
