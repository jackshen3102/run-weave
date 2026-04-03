import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { resolveProtocolFilePath } from "./protocol-path.js";

const rendererDist = "/app/frontend/dist";

test("resolves SPA routes to index.html", () => {
  const resolved = resolveProtocolFilePath(
    "browser-viewer://app/connections",
    rendererDist,
  );

  assert.equal(resolved.status, "ok");
  assert.equal(resolved.filePath, path.join(rendererDist, "index.html"));
});

test("resolves asset files without SPA fallback", () => {
  const resolved = resolveProtocolFilePath(
    "browser-viewer://app/assets/index.js",
    rendererDist,
  );

  assert.equal(resolved.status, "ok");
  assert.equal(resolved.filePath, path.join(rendererDist, "assets", "index.js"));
});
