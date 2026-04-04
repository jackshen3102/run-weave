import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHomePath, resolveStoragePaths } from "./path";

describe("path helpers", () => {
  it("expands a leading home directory token", () => {
    expect(expandHomePath("~/data/session.json", "/Users/tester")).toBe(
      path.join("/Users/tester", "data", "session.json"),
    );
  });

  it("resolves default storage paths under a project-scoped home directory", () => {
    const projectPath = "/Users/tester/workspace/browser-viewer";
    const projectHash = createHash("sha256")
      .update(projectPath)
      .digest("hex")
      .slice(0, 8);
    expect(
      resolveStoragePaths({}, "/Users/tester", projectPath),
    ).toEqual({
      browserProfileDir: path.join(
        "/Users/tester",
        ".browser-profile",
        projectHash,
      ),
      authStoreFile: path.join(
        "/Users/tester",
        ".browser-profile",
        projectHash,
        "auth-store.json",
      ),
      sessionStoreFile: path.join(
        "/Users/tester",
        ".browser-profile",
        projectHash,
        "session-store.json",
      ),
      terminalSessionStoreFile: path.join(
        "/Users/tester",
        ".browser-profile",
        projectHash,
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
      authStoreFile: path.join(
        "/Users/tester",
        "custom-profile",
        "auth-store.json",
      ),
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
          AUTH_STORE_FILE: "~/db/auth.json",
          SESSION_STORE_FILE: "~/db/session.json",
          TERMINAL_SESSION_STORE_FILE: "~/db/terminal-session.json",
        },
        "/Users/tester",
      ),
    ).toEqual({
      browserProfileDir: path.join("/Users/tester", "custom-profile"),
      authStoreFile: path.join("/Users/tester", "db", "auth.json"),
      sessionStoreFile: path.join("/Users/tester", "db", "session.json"),
      terminalSessionStoreFile: path.join(
        "/Users/tester",
        "db",
        "terminal-session.json",
      ),
    });
  });

  it("keeps the legacy default directory when the project path is blank", () => {
    expect(resolveStoragePaths({}, "/Users/tester", "   ")).toEqual({
      browserProfileDir: path.join("/Users/tester", ".browser-profile"),
      authStoreFile: path.join(
        "/Users/tester",
        ".browser-profile",
        "auth-store.json",
      ),
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
});
