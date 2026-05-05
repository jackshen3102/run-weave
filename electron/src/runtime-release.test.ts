import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  recordLastKnownGoodRuntimeRelease,
  resolveActiveRuntimeRelease,
  resolveExternalRuntimeRelease,
  resolveLastKnownGoodRuntimeRelease,
  resolveRuntimeRoot,
} from "./runtime-release.js";

function createTempRuntimeRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "runweave-runtime-"));
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeRuntimeRelease(options: {
  runtimeRoot: string;
  releaseId: string;
  manifest?: unknown;
  writeCurrent?: boolean;
}): void {
  const releaseDir = path.join(
    options.runtimeRoot,
    "releases",
    options.releaseId,
  );
  mkdirSync(path.join(releaseDir, "frontend", "dist"), { recursive: true });
  mkdirSync(path.join(releaseDir, "backend"), { recursive: true });
  writeFileSync(path.join(releaseDir, "frontend", "dist", "index.html"), "");
  writeFileSync(path.join(releaseDir, "backend", "index.cjs"), "");
  writeFileSync(
    path.join(releaseDir, "manifest.json"),
    JSON.stringify(
      options.manifest ?? {
        schemaVersion: 1,
        releaseId: options.releaseId,
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
      },
    ),
  );

  if (options.writeCurrent) {
    writeFileSync(
      path.join(options.runtimeRoot, "current.json"),
      JSON.stringify({ releaseId: options.releaseId }),
    );
  }
}

test("resolveRuntimeRoot uses a runtime directory under user data", () => {
  assert.equal(
    resolveRuntimeRoot("/Users/me/Library/Application Support/Browser Viewer"),
    path.join(
      "/Users/me/Library/Application Support/Browser Viewer",
      "runtime",
    ),
  );
});

test("falls back to bundled runtime when current.json is missing", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    const resolved = resolveActiveRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
    });

    assert.equal(resolved.source, "bundled");
    assert.equal(
      resolved.frontendDistDir,
      path.join("/app/resources", "frontend", "dist"),
    );
    assert.equal(
      resolved.backendEntry,
      path.join("/app/resources", "app.asar", "dist", "backend", "index.cjs"),
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("falls back to bundled runtime when current release does not exist", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    writeFileSync(
      path.join(runtimeRoot, "current.json"),
      JSON.stringify({ releaseId: "missing" }),
    );

    const resolved = resolveActiveRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
    });

    assert.equal(resolved.source, "bundled");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("resolves a valid external runtime release", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    writeRuntimeRelease({
      runtimeRoot,
      releaseId: "2026.05.05-001",
      writeCurrent: true,
    });

    const resolved = resolveActiveRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
    });

    assert.equal(resolved.source, "external");
    assert.equal(resolved.releaseId, "2026.05.05-001");
    assert.equal(
      resolved.frontendDistDir,
      path.join(runtimeRoot, "releases", "2026.05.05-001", "frontend", "dist"),
    );
    assert.equal(
      resolved.backendEntry,
      path.join(
        runtimeRoot,
        "releases",
        "2026.05.05-001",
        "backend",
        "index.cjs",
      ),
    );
    assert.equal(
      resolved.nodePtyDir,
      path.join("/app/resources", "backend", "node_modules", "node-pty"),
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects manifest with missing key files", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    writeRuntimeRelease({
      runtimeRoot,
      releaseId: "broken",
      writeCurrent: true,
    });
    rmSync(
      path.join(
        runtimeRoot,
        "releases",
        "broken",
        "frontend",
        "dist",
        "index.html",
      ),
    );

    const resolved = resolveActiveRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
    });

    assert.equal(resolved.source, "bundled");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects manifest paths that escape the release directory", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    writeRuntimeRelease({
      runtimeRoot,
      releaseId: "escape",
      writeCurrent: true,
      manifest: {
        schemaVersion: 1,
        releaseId: "escape",
        runtimeApiVersion: 1,
        minimumShellVersion: "0.72.0",
        sharedProtocolVersion: "0.1.0",
        frontend: {
          distDir: "frontend/dist",
          index: "../index.html",
        },
        backend: {
          entry: "backend/index.cjs",
        },
      },
    });

    assert.equal(
      resolveExternalRuntimeRelease({
        runtimeRoot,
        resourcesPath: "/app/resources",
        releaseId: "escape",
      }),
      null,
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects manifest files that are not an array", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    writeRuntimeRelease({
      runtimeRoot,
      releaseId: "bad-files",
      writeCurrent: true,
      manifest: {
        schemaVersion: 1,
        releaseId: "bad-files",
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
        files: {},
      },
    });

    const resolved = resolveActiveRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
      shellVersion: "0.72.0",
    });

    assert.equal(resolved.source, "bundled");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects external runtime release when sha256 no longer matches", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    writeRuntimeRelease({
      runtimeRoot,
      releaseId: "tampered",
      writeCurrent: true,
    });
    writeFileSync(
      path.join(runtimeRoot, "releases", "tampered", "backend", "index.cjs"),
      "tampered",
    );

    const resolved = resolveActiveRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
      shellVersion: "0.72.0",
    });

    assert.equal(resolved.source, "bundled");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects external runtime release that requires a newer shell", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    writeRuntimeRelease({
      runtimeRoot,
      releaseId: "future",
      writeCurrent: true,
      manifest: {
        schemaVersion: 1,
        releaseId: "future",
        runtimeApiVersion: 1,
        minimumShellVersion: "99.0.0",
        sharedProtocolVersion: "0.1.0",
        frontend: {
          distDir: "frontend/dist",
          index: "frontend/dist/index.html",
        },
        backend: {
          entry: "backend/index.cjs",
        },
        files: [{ path: "backend/index.cjs", sha256: sha256("") }],
      },
    });

    const resolved = resolveActiveRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
      shellVersion: "0.72.0",
    });

    assert.equal(resolved.source, "bundled");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("records and resolves last known good external runtime", () => {
  const runtimeRoot = createTempRuntimeRoot();
  try {
    writeRuntimeRelease({
      runtimeRoot,
      releaseId: "good",
      writeCurrent: true,
    });
    const release = resolveActiveRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
    });
    recordLastKnownGoodRuntimeRelease(release);

    const lastKnownGood = resolveLastKnownGoodRuntimeRelease({
      runtimeRoot,
      resourcesPath: "/app/resources",
    });

    assert.equal(lastKnownGood?.source, "external");
    assert.equal(lastKnownGood?.releaseId, "good");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
