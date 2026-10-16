import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately opt-in: this command never changes PATH, Codex config or a running instance.
const version = "0.160.1";
const archiveSha256 = "5226394058e04c5404fe737b84fbede38ebf41d88a72eb8b27f3d1c6ea23373b";
const hosts = {
  "darwin-arm64": { target: "aarch64-apple-darwin", sha256: "6e502df69d9220fa305b0c3c7c17ba8f31ab1d4591fc140084dbb823e800c7db" },
  "darwin-x64": { target: "x86_64-apple-darwin", sha256: "cd0ae67e1c2c6cab9c065e3287a56f068961c5592e114c1ccd6e9a4909bba147" },
};
const host = hosts[`${process.platform}-${process.arch}`];
if (!host) throw new Error("Managed Codex currently supports local macOS only");
const hostAsset = `codex-code-mode-host-${host.target}.tar.gz`;
const hostUrl = `https://github.com/openai/codex/releases/download/rust-v${version}/${hostAsset}`;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const patch = path.join(repo, "packages/agent-bridge/codex/context.patch");
const patchHash = createHash("sha256").update(readFileSync(patch)).digest("hex").slice(0, 12);
const launcher = path.join(repo, "packages/agent-bridge/codex/launcher.cjs");
const hooks = path.join(repo, "packages/agent-bridge/hooks");
const dispatch = path.join(repo, "plugins/toolkit/hooks/runweave-hook-dispatch.cjs");
const hookFiles = readdirSync(hooks).filter((name) => name.endsWith(".cjs")).sort();
const bundleHash = createHash("sha256").update(readFileSync(patch)).update(readFileSync(launcher));
for (const name of hookFiles) bundleHash.update(name).update(readFileSync(path.join(hooks, name)));
bundleHash.update(readFileSync(dispatch)).update(host.target).update(host.sha256);
const bundleId = bundleHash.digest("hex").slice(0, 12);
const root = path.join(homedir(), ".cache/runweave/codex", `${version}-${bundleId}`);
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ version, archiveSha256, patchHash, bundleId, host, executable: path.join(root, "bin/codex"), configured: false }));
  process.exit(0);
}
mkdirSync(root, { recursive: true });
const archive = path.join(root, "source.tar.gz");
if (!existsSync(archive)) {
  const response = await fetch(`https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v${version}`);
  if (!response.ok) throw new Error(`Source download failed: ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== archiveSha256) {
  throw new Error("Codex source checksum mismatch; refusing to build");
}
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
const source = path.join(root, `codex-rust-v${version}`);
if (!existsSync(path.join(root, "patched"))) {
  run("tar", ["-xzf", archive]);
  run("git", ["apply", "--check", patch], source);
  run("git", ["apply", patch], source);
  writeFileSync(path.join(root, "patched"), patchHash);
}
// The release tarball updates workspace versions but leaves local packages at 0.0.0 in Cargo.lock.
// Normalize only source-less workspace entries; all registry/git versions and checksums remain pinned.
const lockPath = path.join(source, "codex-rs/Cargo.lock");
const lock = readFileSync(lockPath, "utf8").split("[[package]]").map((entry) =>
  !/^source = /m.test(entry) ? entry.replace('version = "0.0.0"', `version = "${version}"`) : entry,
).join("[[package]]");
writeFileSync(lockPath, lock);
run("cargo", ["build", "--locked", "--release", "-p", "codex-cli", "--bin", "codex", "-j", "4"], path.join(source, "codex-rs"), {
  ...process.env, CARGO_PROFILE_RELEASE_DEBUG: "0", CARGO_INCREMENTAL: "0",
});
// Use the unchanged, signed companion published by OpenAI for the exact same release.
const hostArchive = path.join(root, hostAsset);
if (!existsSync(hostArchive)) {
  const response = await fetch(hostUrl);
  if (!response.ok) throw new Error(`Code Mode host download failed: ${response.status}`);
  writeFileSync(hostArchive, Buffer.from(await response.arrayBuffer()));
}
if (createHash("sha256").update(readFileSync(hostArchive)).digest("hex") !== host.sha256)
  throw new Error("Code Mode host checksum mismatch");
run("tar", ["-xzf", hostArchive]);
const bin = path.join(root, "bin");
mkdirSync(path.join(bin, "native"), { recursive: true });
copyFileSync(path.join(source, "LICENSE"), path.join(root, "LICENSE"));
if (existsSync(path.join(source, "NOTICE"))) copyFileSync(path.join(source, "NOTICE"), path.join(root, "NOTICE"));
copyFileSync(path.join(source, "codex-rs/target/release/codex"), path.join(bin, "native", "codex"));
chmodSync(path.join(bin, "native", "codex"), 0o755);
copyFileSync(path.join(root, `codex-code-mode-host-${host.target}`), path.join(bin, "native", "codex-code-mode-host"));
chmodSync(path.join(bin, "native", "codex-code-mode-host"), 0o755);
copyFileSync(launcher, path.join(bin, "codex"));
mkdirSync(path.join(root, "hooks"), { recursive: true });
copyFileSync(dispatch, path.join(root, "hooks/runweave-hook-dispatch.cjs"));
for (const name of hookFiles) copyFileSync(path.join(hooks, name), path.join(root, "hooks", name));
chmodSync(path.join(bin, "codex"), 0o755);
writeFileSync(path.join(root, "build.json"), JSON.stringify({ version, archiveSha256, patchHash, bundleId, host, executable: path.join(bin, "codex") }, null, 2));
console.log(JSON.stringify({ executable: path.join(bin, "codex"), configured: false }));
