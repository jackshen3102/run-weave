import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPackagedBackendEnv,
  findAvailablePort,
  resolvePackagedBackendPaths,
  resolvePackagedBackendRuntimeCandidates,
} from "./backend-runtime.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeRuntimeRelease(runtimeRoot: string, releaseId: string): void {
  const releaseDir = path.join(runtimeRoot, "releases", releaseId);
  mkdirSync(path.join(releaseDir, "frontend", "dist"), { recursive: true });
  mkdirSync(path.join(releaseDir, "backend"), { recursive: true });
  writeFileSync(path.join(releaseDir, "frontend", "dist", "index.html"), "");
  writeFileSync(path.join(releaseDir, "backend", "index.cjs"), "");
  writeFileSync(
    path.join(releaseDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      releaseId,
      runtimeApiVersion: 1,
      minimumShellVersion: "0.72.0",
      sharedProtocolVersion: "0.1.0",
      frontend: {
        distDir: "frontend/dist",
        index: "frontend/dist/index.html",
      },
      backend: {
        entry: "backend/index.cjs",
      },
      files: [
        { path: "frontend/dist/index.html", sha256: sha256("") },
        { path: "backend/index.cjs", sha256: sha256("") },
      ],
    }),
  );
}

test("resolves packaged backend resources under electron resources path", () => {
  const resolved = resolvePackagedBackendPaths(
    "/Applications/Browser Viewer.app/Contents/Resources",
  );

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
  assert.equal(resolved.releaseId, "bundled");
  assert.equal(resolved.source, "bundled");
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
  assert.equal(env.HOST, "0.0.0.0");
  assert.equal(env.FRONTEND_DIST_DIR, resolved.frontendDistDir);
  assert.equal(env.RUNWEAVE_RUNTIME_RELEASE_ID, "bundled");
  assert.equal(env.BROWSER_VIEWER_NODE_PTY_DIR, resolved.nodePtyDir);
  assert.equal(env.AUTH_USERNAME, "admin");
  assert.equal(env.AUTH_PASSWORD, "secret");
  assert.equal(env.AUTH_JWT_SECRET, "jwt-secret");
  assert.equal(env.SESSION_RESTORE_ENABLED, "true");
});

test("adds common macOS CLI paths for packaged backend commands", () => {
  const resolved = resolvePackagedBackendPaths("/app/resources");

  const env = buildPackagedBackendEnv({
    baseEnv: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    backendPort: 5007,
    backendPaths: resolved,
  });

  const pathEntries = env.PATH?.split(path.delimiter) ?? [];
  assert.ok(pathEntries.includes("/opt/homebrew/bin"));
  assert.ok(pathEntries.includes("/usr/local/bin"));
  assert.equal(
    pathEntries.filter((entry) => entry === "/opt/homebrew/bin").length,
    1,
  );
});

test("resolves packaged frontend resources for backend static serving", () => {
  const resolved = resolvePackagedBackendPaths("/app/resources");

  assert.equal(
    resolved.frontendDistDir,
    path.join("/app/resources", "frontend", "dist"),
  );
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

test("findAvailablePort skips ports reported as unavailable", async () => {
  const unavailable = new Set([5001, 5002]);

  const port = await findAvailablePort(5001, async (candidate) => {
    return !unavailable.has(candidate);
  });

  assert.equal(port, 5003);
});

test("prefers last-known-good before bundled when current release is invalid", () => {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "runweave-runtime-"));
  try {
    writeRuntimeRelease(runtimeRoot, "good");
    writeFileSync(
      path.join(runtimeRoot, "current.json"),
      JSON.stringify({ releaseId: "missing" }),
    );
    writeFileSync(
      path.join(runtimeRoot, "last-known-good.json"),
      JSON.stringify({ releaseId: "good" }),
    );

    const plan = resolvePackagedBackendRuntimeCandidates({
      runtimeRoot,
      resourcesPath: "/app/resources",
      shellVersion: "0.72.0",
    });

    assert.equal(plan.currentReleaseInvalid, true);
    assert.equal(plan.candidates[0]?.releaseId, "good");
    assert.equal(plan.candidates[1]?.releaseId, "bundled");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
