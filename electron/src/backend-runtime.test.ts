import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildPackagedBackendEnv,
  resolvePackagedBackendPaths,
} from "./backend-runtime.js";

test("resolves packaged backend resources under electron resources path", () => {
  const resolved = resolvePackagedBackendPaths("/Applications/Browser Viewer.app/Contents/Resources");

  assert.equal(
    resolved.backendEntry,
    path.join(
      "/Applications/Browser Viewer.app/Contents/Resources",
      "app.asar",
      "dist",
      "backend",
      "index.cjs",
    ),
  );
  assert.equal(
    resolved.nodePtyDir,
    path.join(
      "/Applications/Browser Viewer.app/Contents/Resources",
      "backend",
      "node_modules",
      "node-pty",
    ),
  );
});

test("builds packaged backend env with runtime paths and assigned port", () => {
  const resolved = resolvePackagedBackendPaths("/app/resources");

  const env = buildPackagedBackendEnv({
    baseEnv: {
      AUTH_USERNAME: "admin",
      AUTH_PASSWORD: "secret",
      AUTH_JWT_SECRET: "jwt-secret",
      SESSION_RESTORE_ENABLED: "true",
    },
    backendPort: 5007,
    backendPaths: resolved,
  });

  assert.equal(env.PORT, "5007");
  assert.equal(env.PORT_STRICT, "true");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.BROWSER_VIEWER_NODE_PTY_DIR, resolved.nodePtyDir);
  assert.equal(env.AUTH_USERNAME, "admin");
  assert.equal(env.AUTH_PASSWORD, "secret");
  assert.equal(env.AUTH_JWT_SECRET, "jwt-secret");
  assert.equal(env.SESSION_RESTORE_ENABLED, "true");
});

test("fills packaged backend auth defaults when process env is missing", () => {
  const resolved = resolvePackagedBackendPaths("/app/resources");

  const env = buildPackagedBackendEnv({
    baseEnv: {},
    backendPort: 5007,
    backendPaths: resolved,
  });

  assert.equal(env.AUTH_USERNAME, "admin");
  assert.equal(env.AUTH_PASSWORD, "admin");
  assert.equal(env.AUTH_JWT_SECRET, "browser-viewer-local-jwt-secret");
});
