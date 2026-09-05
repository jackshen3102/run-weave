import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getAbi } from "node-abi";
import {
  electronVersion,
  stagingAppDir,
} from "./activity-sqlite-runtime-paths.mjs";

function listFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Activity runtime may not contain symlink: ${absolute}`);
    if (entry.isDirectory()) files.push(...listFiles(root, absolute));
    else if (entry.isFile())
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resolveNativeBinding(packageDir) {
  const prebuildPlatform =
    process.platform === "linux" &&
    !process.report.getReport().header.glibcVersionRuntime
      ? "linuxmusl"
      : process.platform;
  const candidates = [
    path.join(
      packageDir,
      "prebuilds",
      `${prebuildPlatform}-${process.arch}.node`,
    ),
    path.join(packageDir, "build", "Release", "better_sqlite3.node"),
  ];
  const nativeBinding = candidates.find((candidate) => existsSync(candidate));
  if (!nativeBinding)
    throw new Error("Electron better-sqlite3 binding is missing");
  return nativeBinding;
}

export function finalizeActivitySqliteRuntime(
  workerEntry,
  evolutionWorkerEntry,
) {
  const nodeModules = path.join(stagingAppDir, "node_modules");
  if (
    !existsSync(workerEntry) ||
    !existsSync(evolutionWorkerEntry) ||
    !existsSync(nodeModules)
  ) {
    throw new Error("Activity SQLite staging is incomplete");
  }
  const resourcesBackendDir = path.dirname(workerEntry);
  const runtimeNodeModules = path.join(resourcesBackendDir, "node_modules");
  mkdirSync(runtimeNodeModules, { recursive: true });
  const runtimePackageNames = ["better-sqlite3"];
  for (const packageName of runtimePackageNames) {
    cpSync(
      path.join(nodeModules, packageName),
      path.join(runtimeNodeModules, packageName),
      { recursive: true, dereference: true },
    );
  }

  const nativeBinding = resolveNativeBinding(
    path.join(runtimeNodeModules, "better-sqlite3"),
  );
  const nativeBindingRelative = path
    .relative(resourcesBackendDir, nativeBinding)
    .split(path.sep)
    .join("/");
  const runtimeRoots = [
    workerEntry,
    evolutionWorkerEntry,
    ...runtimePackageNames.map((packageName) =>
      path.join(runtimeNodeModules, packageName),
    ),
  ];
  const files = runtimeRoots
    .flatMap((entry) =>
      statSync(entry).isDirectory()
        ? listFiles(resourcesBackendDir, entry)
        : [path.relative(resourcesBackendDir, entry).split(path.sep).join("/")],
    )
    .sort()
    .map((file) => ({
      path: file,
      size: statSync(path.join(resourcesBackendDir, file)).size,
      sha256: hashFile(path.join(resourcesBackendDir, file)),
    }));
  const treeSha256 = createHash("sha256")
    .update(
      files
        .map((file) => `${file.path}\0${file.size}\0${file.sha256}`)
        .join("\n"),
    )
    .digest("hex");
  writeFileSync(
    path.join(resourcesBackendDir, "activity-sqlite-runtime-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        electronVersion,
        nodeModuleAbi: getAbi(electronVersion, "electron"),
        platform: process.platform,
        arch: process.arch,
        workerEntry: "activity-sqlite-worker.cjs",
        evolutionWorkerEntry: "evolution-sqlite-worker.cjs",
        packageEntry: "node_modules/better-sqlite3/lib/index.js",
        packageManifest: "node_modules/better-sqlite3/package.json",
        nativeBinding: nativeBindingRelative,
        files,
        treeSha256,
      },
      null,
      2,
    )}\n`,
  );
  return resourcesBackendDir;
}
