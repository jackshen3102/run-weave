import { describe, expect, it } from "vitest";
import { resolveNodePtyDirectory } from "./node-pty-path.js";

describe("resolveNodePtyDirectory", () => {
  it("uses explicit node-pty directory from environment when provided", () => {
    const env = { BROWSER_VIEWER_NODE_PTY_DIR: "/tmp/node-pty" };

    expect(resolveNodePtyDirectory(env)).toBe("/tmp/node-pty");
  });

  it("returns null when packaged node-pty directory is not configured", () => {
    expect(resolveNodePtyDirectory({})).toBeNull();
  });
});
