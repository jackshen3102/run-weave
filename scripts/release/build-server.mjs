import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyNativeLockRuntime } from "../../packages/config-node/scripts/native-runtime.mjs";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pkg = JSON.parse(
  readFileSync(
    path.join(repo, "packages/runweave-server/package.json"),
    "utf8",
  ),
);
const version =
  process.argv.find((a) => a.startsWith("--version="))?.slice(10) ??
  pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("A numeric semantic version is required");
if (process.versions.node.split(".")[0] !== "22")
  throw new Error("Build with Node 22");
const output = path.resolve(
  process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
    path.join(repo, ".runtime-artifacts/server"),
);
const target = `${process.platform}-${process.arch}`;
const main = path.join(output, "package");
const platform = path.join(output, target);
const payload = path.join(main, "payload");
function run(command, args, cwd = repo, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
function json(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
// Do not leave pre-refactor or previous-build tarballs available for accidental publication.
for (const filename of [
  `runweave-server-${version}.tgz`,
  `runweave-server-${target}-${version}.tgz`,
])
  rmSync(path.join(output, filename), { force: true });
rmSync(main, { recursive: true, force: true });
rmSync(platform, { recursive: true, force: true });
mkdirSync(payload, { recursive: true });
run(process.execPath, [
  "scripts/release/build-backend.mjs",
  "--build-only",
  `--output-dir=${payload}`,
  `--release-id=server-${version}`,
]);
for (const name of ["install.mjs", "manifest.json"])
  rmSync(path.join(payload, name));
run(process.execPath, [
  "scripts/install/app-server.mjs",
  "--build-only",
  `--output-dir=${path.join(payload, "app-server")}`,
  `--release-id=server-${version}`,
]);
const { build } = createRequire(
  path.join(repo, "packages/runweave-cli/package.json"),
)("esbuild");
await build({
  bundle: true,
  entryPoints: [path.join(repo, "packages/runweave-server/src/runtime.ts")],
  outfile: path.join(payload, "server/index.cjs"),
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["fs-native-extensions"],
  define: { "import.meta.url": "__IMPORT_META_URL__" },
  banner: {
    js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;",
  },
});
copyNativeLockRuntime(path.join(payload, "server"));

for (const component of ["backend", "app-server", "server"]) {
  // npm excludes nested node_modules from files; ship them as platform resources.
  const modules = path.join(payload, component, "node_modules");
  copyNativeLockRuntime(path.join(payload, component));
  mkdirSync(path.join(platform, "native"), { recursive: true });
  renameSync(modules, path.join(platform, "native", component));
}
// resource-sampler is platform-specific, keep the common main package portable.
const sampler = path.join(payload, "backend/resource-sampler");
if (process.platform === "darwin") {
  mkdirSync(path.join(platform, "resources"), { recursive: true });
  renameSync(sampler, path.join(platform, "resources/resource-sampler"));
}
function files(dir, prefix = "") {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const file = path.join(dir, name),
        relative = path.posix.join(prefix, name);
      if (statSync(file).isDirectory()) return files(file, relative);
      const bytes = readFileSync(file);
      return [
        {
          path: relative,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ];
    });
}
const backendManifest = files(payload);
const nativeFiles = ["backend", "server", "app-server"].flatMap((component) =>
  files(path.join(platform, "native", component), `${component}/node_modules`),
);
const schemas = [
  "backend/src/activity/database",
  "backend/src/evolution/storage",
  "backend/src/scheduled-tasks/storage",
  "app-server/src/events",
  "app-server/src/state",
  "packages/shared/src/configuration",
];
const compatibility = createHash("sha256");
for (const directory of schemas)
  for (const file of files(path.join(repo, directory)))
    compatibility.update(`${directory}/${file.path}:${file.sha256}\n`);
const manifest = {
  schemaVersion: 1,
  managementApiVersion: 1,
  version,
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim(),
  platform: process.platform,
  arch: process.arch,
  nodeModuleAbi: process.versions.modules,
  sqlitePrebuild: `${process.platform}-${process.arch}.node`,
  dataCompatibility: compatibility.digest("hex"),
  files: [...backendManifest, ...nativeFiles],
};
if (process.platform === "darwin")
  manifest.files.push(...files(path.join(platform, "resources"), "backend"));
json(path.join(platform, "manifest.json"), manifest);
json(path.join(platform, "package.json"), {
  name: `@runweave/server-${target}`,
  version,
  license: "MIT",
  os: [process.platform],
  cpu: [process.arch],
  ...(process.platform === "linux" ? { libc: ["glibc"] } : {}),
  files: ["payload", "native.tar.gz", "manifest.json"],
});
cpSync(
  path.join(repo, "packages/runweave-server/bin"),
  path.join(main, "bin"),
  { recursive: true },
);
cpSync(
  path.join(repo, "packages/runweave-server/README.md"),
  path.join(main, "README.md"),
);
pkg.files = ["bin", "README.md"];
delete pkg.scripts;
pkg.version = version;
pkg.optionalDependencies = Object.fromEntries(
  ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map((name) => [
    `@runweave/server-${name}`,
    version,
  ]),
);
json(path.join(main, "package.json"), pkg);
// Shared startup uses this manifest, populated from the selected platform at activation.
const start = path.join(payload, "start.mjs");
writeFileSync(
  start,
  readFileSync(start, "utf8").replace(
    '"manifest.json"',
    '"server-manifest.json"',
  ),
);
// The startup adjustment changes a common file; finalize its checksum.
manifest.files = manifest.files.map((file) =>
  file.path === "start.mjs"
    ? files(payload).find((entry) => entry.path === "start.mjs")
    : file,
);
json(path.join(platform, "manifest.json"), manifest);
cpSync(
  path.join(repo, "packages/runweave-server/bin"),
  path.join(payload, "bin"),
  { recursive: true },
);
manifest.files.push(...files(path.join(payload, "bin"), "bin"));
json(path.join(platform, "manifest.json"), manifest);
const expanded = path.join(output, ".native-expanded");
rmSync(expanded, { recursive: true, force: true });
for (const component of ["backend", "server", "app-server"])
  cpSync(
    path.join(platform, "native", component),
    path.join(expanded, component, "node_modules"),
    { recursive: true },
  );
if (process.platform === "darwin")
  cpSync(path.join(platform, "resources"), path.join(expanded, "backend"), {
    recursive: true,
  });
run("tar", ["-czf", path.join(platform, "native.tar.gz"), "-C", expanded, "."]);
rmSync(expanded, { recursive: true, force: true });
rmSync(path.join(platform, "native"), { recursive: true, force: true });
rmSync(path.join(platform, "resources"), { recursive: true, force: true });
renameSync(payload, path.join(platform, "payload"));
console.log(
  JSON.stringify({ package: main, platformPackage: platform, version, target }),
);

run(process.execPath, [
  "scripts/release/build-cli.mjs",
  `--out=${path.join(output, "cli-package")}`,
]);
