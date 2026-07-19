import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const artifactsRoot = path.resolve(
  process.env.RUNWEAVE_RUNTIME_ARTIFACTS_ROOT ??
    path.join(repoRoot, ".runtime-artifacts"),
);
const runtimeApiVersion = 1;

function readPackageVersion(packagePath) {
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function createReleaseId() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join(".");
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${date}-${time}`;
}

function listFiles(root, dir = root) {
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...listFiles(root, fullPath));
      continue;
    }
    if (stat.isFile()) {
      entries.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }
  return entries;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const releaseId =
  process.argv.find((arg) => arg.startsWith("--release-id="))?.slice(13) ??
  createReleaseId();
const shellVersion =
  process.argv.find((arg) => arg.startsWith("--shell-version="))?.slice(16) ??
  readPackageVersion(path.join(repoRoot, "electron", "package.json"));

const isolatedBuildRoot = process.env.RUNWEAVE_RUNTIME_BUILD_ROOT?.trim();
const frontendDist = isolatedBuildRoot
  ? path.join(path.resolve(isolatedBuildRoot), "frontend", "dist")
  : path.join(repoRoot, "frontend", "dist");
const electronDist = isolatedBuildRoot
  ? path.join(path.resolve(isolatedBuildRoot), "electron", "dist")
  : path.join(repoRoot, "electron", "dist");
const resourcesBackendDir = path.join(electronDist, "backend");
if (isolatedBuildRoot) {
  rmSync(path.resolve(isolatedBuildRoot), { recursive: true, force: true });
  run("pnpm", [
    "-C",
    "frontend",
    "exec",
    "vite",
    "build",
    "--outDir",
    frontendDist,
  ]);
  const isolatedElectronEnv = {
    ...process.env,
    RUNWEAVE_ACTIVITY_SQLITE_ARTIFACT_ROOT: path.join(
      path.resolve(isolatedBuildRoot),
      "native-artifacts",
      "activity-sqlite",
    ),
    RUNWEAVE_ELECTRON_BUNDLE_OUTDIR: electronDist,
  };
  run("node", ["scripts/prepare-better-sqlite3-runtime.mjs"], {
    cwd: path.join(repoRoot, "electron"),
    env: isolatedElectronEnv,
  });
  run("node", ["scripts/bundle.mjs"], {
    cwd: path.join(repoRoot, "electron"),
    env: isolatedElectronEnv,
  });
} else {
  run("pnpm", ["--filter", "./frontend", "build"]);
  run("pnpm", ["--filter", "./electron", "build"]);
}

const releaseDir = path.join(artifactsRoot, releaseId);
const backendEntry = path.join(
  electronDist,
  "backend",
  "index.cjs",
);
const cliEntry = path.join(
  electronDist,
  "cli",
  "index.cjs",
);
if (!existsSync(path.join(frontendDist, "index.html"))) {
  throw new Error("frontend dist is missing index.html");
}
if (!existsSync(backendEntry)) {
  throw new Error("backend bundle is missing electron/dist/backend/index.cjs");
}
if (!existsSync(cliEntry)) {
  throw new Error("CLI bundle is missing electron/dist/cli/index.cjs");
}
if (!existsSync(path.join(resourcesBackendDir, "activity-sqlite-worker.cjs"))) {
  throw new Error("Activity SQLite Electron runtime is missing");
}
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(path.join(releaseDir, "frontend"), { recursive: true });
mkdirSync(path.join(releaseDir, "backend"), { recursive: true });
mkdirSync(path.join(releaseDir, "cli"), { recursive: true });
cpSync(frontendDist, path.join(releaseDir, "frontend", "dist"), {
  recursive: true,
});
cpSync(backendEntry, path.join(releaseDir, "backend", "index.cjs"));
cpSync(resourcesBackendDir, path.join(releaseDir, "backend"), {
  recursive: true,
  dereference: true,
});
cpSync(cliEntry, path.join(releaseDir, "cli", "index.cjs"));

const files = listFiles(releaseDir)
  .filter((filePath) => filePath !== "manifest.json")
  .map((filePath) => ({
    path: filePath,
    size: statSync(path.join(releaseDir, filePath)).size,
    sha256: sha256(path.join(releaseDir, filePath)),
  }));
const treeSha256 = createHash("sha256")
  .update(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n"))
  .digest("hex");

const manifest = {
  schemaVersion: 1,
  releaseId,
  runtimeApiVersion,
  minimumShellVersion: shellVersion,
  sharedProtocolVersion: readPackageVersion(
    path.join(repoRoot, "packages", "shared", "package.json"),
  ),
  createdAt: new Date().toISOString(),
  frontend: {
    distDir: "frontend/dist",
    index: "frontend/dist/index.html",
  },
  backend: {
    entry: "backend/index.cjs",
    activityWorkerEntry: "backend/activity-sqlite-worker.cjs",
    betterSqlitePackageDir: "backend/node_modules/better-sqlite3",
    betterSqliteNativeBinding:
      "backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  },
  cli: {
    entry: "cli/index.cjs",
  },
  files,
  treeSha256,
};

writeFileSync(
  path.join(releaseDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const zipPath = path.join(artifactsRoot, `runweave-runtime-${releaseId}.zip`);
rmSync(zipPath, { force: true });
run("zip", ["-qry", zipPath, "."], { cwd: releaseDir });

console.log(`[runtime] release staged: ${releaseDir}`);
console.log(`[runtime] zip written: ${zipPath}`);
