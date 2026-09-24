import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Release contains symlink: ${absolute}`);
      if (entry.isDirectory()) return listFiles(root, absolute);
      if (!entry.isFile())
        throw new Error(`Unexpected release entry: ${absolute}`);
      return [path.relative(root, absolute).split(path.sep).join("/")];
    });
}

function verifyRelease(root) {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    !/^[a-zA-Z0-9._-]+$/.test(manifest.releaseId) ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.nodeModuleAbi !== process.versions.modules ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Backend release target or manifest is invalid");
  }
  const actual = listFiles(root).filter((file) => file !== "manifest.json");
  const expected = manifest.files.map((file) => file.path);
  if (
    new Set(expected).size !== expected.length ||
    actual.length !== expected.length ||
    actual.some((file, index) => file !== expected[index])
  ) {
    throw new Error("Backend release file list differs from manifest");
  }
  for (const file of manifest.files) {
    const absolute = path.join(root, file.path);
    if (
      statSync(absolute).size !== file.size ||
      sha256(absolute) !== file.sha256
    ) {
      throw new Error(
        `Backend release file differs from manifest: ${file.path}`,
      );
    }
  }
  const treeSha256 = createHash("sha256")
    .update(
      manifest.files
        .map((file) => `${file.path}\0${file.size}\0${file.sha256}`)
        .join("\n"),
    )
    .digest("hex");
  if (treeSha256 !== manifest.treeSha256) {
    throw new Error("Backend release tree hash differs from manifest");
  }
  const requireBackend = createRequire(path.join(root, "backend", "index.cjs"));
  const Database = requireBackend("better-sqlite3");
  const database = new Database(":memory:");
  database.prepare("SELECT 1").get();
  database.close();
  requireBackend("node-pty");
  return manifest;
}

const args = process.argv.slice(2);
const source = path.resolve(
  args.find((arg) => !arg.startsWith("--")) ??
    path.dirname(fileURLToPath(import.meta.url)),
);
const homeArg = args.find((arg) => arg.startsWith("--home="));
const home = path.resolve(
  homeArg?.slice("--home=".length) ??
    path.join(os.homedir(), ".runweave", "backend-runtime"),
);
const manifest = verifyRelease(source);
const releasesDir = path.join(home, "releases");
const releaseDir = path.join(releasesDir, manifest.releaseId);
const stagedDir = path.join(
  releasesDir,
  `.${manifest.releaseId}.installing-${process.pid}`,
);
mkdirSync(releasesDir, { recursive: true, mode: 0o700 });
if (existsSync(releaseDir)) {
  verifyRelease(releaseDir);
} else {
  rmSync(stagedDir, { recursive: true, force: true });
  try {
    cpSync(source, stagedDir, { recursive: true, errorOnExist: true });
    verifyRelease(stagedDir);
    renameSync(stagedDir, releaseDir);
  } finally {
    rmSync(stagedDir, { recursive: true, force: true });
  }
}
const current = path.join(home, "current");
if (existsSync(current) && !lstatSync(current).isSymbolicLink()) {
  throw new Error(`Backend current path is not a symlink: ${current}`);
}
const next = path.join(home, `.current-${process.pid}`);
rmSync(next, { force: true });
symlinkSync(path.join("releases", manifest.releaseId), next);
renameSync(next, current);
console.log(`[backend-release] installed ${releaseDir}`);
console.log(`[backend-release] active ${current}`);
console.log(
  `[backend-release] start with: node ${path.join(current, "start.mjs")}`,
);
