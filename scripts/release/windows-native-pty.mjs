// The pinned node-pty patch contains native ownership fixes; upstream prebuilds
// cannot contain them. Compile on Windows or consume the exact CI native artifact.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(repo, "backend/node_modules/node-pty");
const output = path.join(repo, ".runtime-artifacts/windows-pty");
const binaries = ["conpty.node", "conpty_console_list.node"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function sourceDigest() {
  const entries = [];
  function visit(relative) {
    const absolute = path.join(source, relative);
    const children = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of children) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else entries.push(child);
    }
  }
  for (const directory of ["src", "lib", "third_party"]) visit(directory);
  entries.push("binding.gyp", "package.json");
  return hash(entries.sort().map(relative => {
    const bytes = readFileSync(path.join(source, relative));
    const content = /\.(?:cc|h|js|json|gyp|ts|map)$/.test(relative)
      ? Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n")) : bytes;
    return `${relative}\0${hash(content)}`;
  }).join("\n"));
}

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows PTY build failed: ${path.basename(script)}`);
}

export function prepareWindowsPty() {
  if (process.platform !== "win32") return source;
  const expected = {
    schemaVersion: 1,
    version: JSON.parse(readFileSync(path.join(source, "package.json"))).version,
    platform: process.platform,
    arch: process.arch,
    nodeModuleAbi: process.versions.modules,
    sourceSha256: sourceDigest(),
  };
  const artifact = process.env.RUNWEAVE_WINDOWS_PTY_NATIVE_ARTIFACT
    ? path.resolve(process.env.RUNWEAVE_WINDOWS_PTY_NATIVE_ARTIFACT)
    : path.join(output, "native");
  const manifestPath = path.join(artifact, "manifest.json");
  const target = path.join(output, "package");
  mkdirSync(output, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, dereference: true });
  const prebuild = path.join(target, "prebuilds", `win32-${process.arch}`);
  if (!existsSync(manifestPath)) {
    if (process.env.RUNWEAVE_WINDOWS_PTY_NATIVE_ARTIFACT)
      throw new Error("Windows PTY native artifact manifest is missing");
    const require = createRequire(path.join(source, "package.json"));
    const addon = path.dirname(require.resolve("node-addon-api/package.json"));
    cpSync(addon, path.join(target, "node_modules/node-addon-api"), { recursive: true });
    const gyp = path.join(path.dirname(process.execPath), "node_modules/npm/node_modules/node-gyp/bin/node-gyp.js");
    if (!existsSync(gyp)) throw new Error("Windows PTY compilation requires the Node distribution's node-gyp");
    run(gyp, ["rebuild", "--release"], target);
    run(path.join(target, "scripts/post-install.js"), [], target);
    mkdirSync(artifact, { recursive: true });
    for (const name of binaries) cpSync(path.join(target, "build/Release", name), path.join(artifact, name));
    writeFileSync(manifestPath, JSON.stringify({ ...expected, files: binaries.map(name => ({ name, sha256: hash(readFileSync(path.join(artifact, name))) })) }, null, 2) + "\n");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [key, value] of Object.entries(expected))
    if (manifest[key] !== value) throw new Error(`Windows PTY artifact ${key} does not match installed patched source`);
  if (manifest.files?.length !== binaries.length) throw new Error("Invalid Windows PTY artifact file list");
  mkdirSync(prebuild, { recursive: true });
  for (const name of binaries) {
    const entry = manifest.files.find(file => file.name === name);
    const binary = readFileSync(path.join(artifact, name));
    if (!entry || entry.sha256 !== hash(binary)) throw new Error(`Windows PTY artifact hash mismatch: ${name}`);
    cpSync(path.join(artifact, name), path.join(prebuild, name));
  }
  // Both the compiled binding and bundled console must resolve from this folder.
  const versions = readdirSync(path.join(source, "third_party/conpty"));
  if (versions.length !== 1) throw new Error("Ambiguous bundled ConPTY version");
  cpSync(path.join(source, "third_party/conpty", versions[0], `win10-${process.arch}`), path.join(prebuild, "conpty"), { recursive: true });
  rmSync(path.join(target, "build"), { recursive: true, force: true });
  console.log(`[windows-pty] verified patched native source ${expected.sourceSha256}`);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareWindowsPty();
