import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const requireFromElectron = createRequire(
  path.join(repoRoot, "electron", "package.json"),
);
const { build } = requireFromElectron("esbuild");
const backendPackage = JSON.parse(
  readFileSync(path.join(repoRoot, "backend", "package.json"), "utf8"),
);
const releaseId =
  process.argv.find((arg) => arg.startsWith("--release-id="))?.slice(13) ??
  `backend-${Date.now()}`;
if (!/^[a-zA-Z0-9._-]+$/.test(releaseId)) {
  throw new Error(`Invalid backend release ID: ${releaseId}`);
}
const artifactsRoot = path.join(
  repoRoot,
  ".runtime-artifacts",
  "backend-standalone",
);
const releaseDir = path.join(artifactsRoot, releaseId);
const backendDir = path.join(releaseDir, "backend");
const prebuildPlatform =
  process.platform === "linux" &&
  !process.report.getReport().header.glibcVersionRuntime
    ? "linuxmusl"
    : process.platform;
const sqlitePrebuild = `${prebuildPlatform}-${process.arch}.node`;
const ptyPrebuild = `${process.platform}-${process.arch}`;

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
}

function copyNativePackage(name, include) {
  const source = path.join(repoRoot, "backend", "node_modules", name);
  const manifest = JSON.parse(
    readFileSync(path.join(source, "package.json"), "utf8"),
  );
  if (manifest.version !== backendPackage.dependencies[name]) {
    throw new Error(
      `${name} does not match backend/package.json; run pnpm install --frozen-lockfile`,
    );
  }
  const target = path.join(backendDir, "node_modules", name);
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (entry) => include(path.relative(source, entry)),
  });
}

function listFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(root, absolute);
      if (!entry.isFile())
        throw new Error(`Unexpected release entry: ${absolute}`);
      return [path.relative(root, absolute).split(path.sep).join("/")];
    });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(backendDir, { recursive: true });
run("pnpm", ["--filter", "./frontend", "build"]);
cpSync(
  path.join(repoRoot, "frontend", "dist"),
  path.join(releaseDir, "frontend", "dist"),
  { recursive: true },
);

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["better-sqlite3", "node-pty"],
  define: { "import.meta.url": "__IMPORT_META_URL__" },
  banner: {
    js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;",
  },
};
for (const [source, output] of [
  ["backend/src/index.ts", "index.cjs"],
  [
    "backend/src/activity/database/sqlite-worker.ts",
    "activity-sqlite-worker.cjs",
  ],
  [
    "backend/src/evolution/storage/sqlite-worker.ts",
    "evolution-sqlite-worker.cjs",
  ],
  [
    "backend/src/scheduled-tasks/storage/sqlite-worker.ts",
    "scheduled-tasks-sqlite-worker.cjs",
  ],
]) {
  await build({
    ...shared,
    entryPoints: [path.join(repoRoot, source)],
    outfile: path.join(backendDir, output),
  });
}

copyNativePackage(
  "better-sqlite3",
  (relative) =>
    !relative ||
    relative === "lib" ||
    relative.startsWith(`lib${path.sep}`) ||
    relative === "prebuilds" ||
    relative === path.join("prebuilds", sqlitePrebuild) ||
    relative === "package.json" ||
    relative === "LICENSE",
);
copyNativePackage(
  "node-pty",
  (relative) =>
    !relative ||
    relative === "lib" ||
    relative.startsWith(`lib${path.sep}`) ||
    relative === "prebuilds" ||
    relative === path.join("prebuilds", ptyPrebuild) ||
    relative.startsWith(`prebuilds${path.sep}${ptyPrebuild}${path.sep}`) ||
    relative === "package.json" ||
    relative === "LICENSE",
);
cpSync(
  path.join(repoRoot, "scripts", "release", "backend-start.mjs"),
  path.join(releaseDir, "start.mjs"),
);
cpSync(
  path.join(repoRoot, "scripts", "install", "backend.mjs"),
  path.join(releaseDir, "install.mjs"),
);

const files = listFiles(releaseDir).map((file) => ({
  path: file,
  size: statSync(path.join(releaseDir, file)).size,
  sha256: sha256(path.join(releaseDir, file)),
}));
const treeSha256 = createHash("sha256")
  .update(
    files
      .map((file) => `${file.path}\0${file.size}\0${file.sha256}`)
      .join("\n"),
  )
  .digest("hex");
writeFileSync(
  path.join(releaseDir, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      releaseId,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      nodeModuleAbi: process.versions.modules,
      sqlitePrebuild,
      ptyPrebuild,
      files,
      treeSha256,
    },
    null,
    2,
  )}\n`,
);
run("node", [
  path.join(releaseDir, "install.mjs"),
  `--home=${path.join(artifactsRoot, ".verify")}`,
]);
rmSync(path.join(artifactsRoot, ".verify"), { recursive: true, force: true });
run("tar", ["-czf", `${releaseId}.tar.gz`, releaseId], artifactsRoot);
console.log(`[backend-release] built ${releaseDir}`);
console.log(
  `[backend-release] archive ${path.join(artifactsRoot, `${releaseId}.tar.gz`)}`,
);
