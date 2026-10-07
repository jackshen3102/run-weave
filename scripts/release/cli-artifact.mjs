import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { compareVersions, incrementMinorVersion } from "../update/core.mjs";
import { runCaptureChecked, runChecked } from "../update/system.mjs";

const require = createRequire(
  new URL("../../packages/runweave-cli/package.json", import.meta.url),
);
const { tryLock } = require("fs-native-extensions");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function cliReleaseHome(prefix) {
  return path.join(prefix, "lib", "runweave-cli-releases");
}

/** One owner across worktrees; kernel releases the lock if the updater exits. */
export async function withCliReleaseLock(prefix, action) {
  const home = cliReleaseHome(prefix);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const lock = await fs.open(path.join(home, "update.lock"), "a+", 0o600);
  try {
    if (!tryLock(lock.fd))
      throw new Error(
        "Another global CLI update is running; retry after it finishes.",
      );
    return await action();
  } finally {
    await lock.close();
  }
}

/** Hash the shipped package, excluding its assigned identity and provenance. */
export async function cliContentHash(root) {
  const pkg = await readJson(path.join(root, "package.json"));
  if (!pkg) return null;
  const content = { ...pkg };
  delete content.version;
  const hash = createHash("sha256").update(JSON.stringify(content));
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (["dist/release.json", "dist/build-info.json"].includes(relative))
        continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(file);
        hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
      } else throw new Error(`Unsupported CLI artifact entry: ${relative}`);
    }
  }
  try {
    await visit(path.join(root, "dist"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return hash.digest("hex");
}

function checkedVersion(value) {
  if (
    typeof value !== "string" ||
    !versionPattern.test(value) ||
    value.split(".").some((part) => !Number.isSafeInteger(Number(part)))
  ) {
    throw new Error(`Invalid CLI release version: ${value}`);
  }
  return value;
}

// Caller holds the prefix lock and has already built the current CLI.
export async function installCliArtifact({ sourceRoot, plan }) {
  const home = cliReleaseHome(plan.prefix);
  const source = path.join(sourceRoot, "packages", "runweave-cli");
  const installed = path.dirname(path.dirname(plan.entry));
  const stage = await fs.mkdtemp(path.join(home, ".stage-"));
  try {
    const candidate = path.join(stage, "package");
    await fs.mkdir(candidate);
    await fs.copyFile(
      path.join(source, "package.json"),
      path.join(candidate, "package.json"),
    );
    await fs.cp(path.join(source, "dist"), path.join(candidate, "dist"), {
      recursive: true,
    });
    await fs.rm(path.join(candidate, "dist", "release.json"), { force: true });
    const pkg = await readJson(path.join(candidate, "package.json"));
    const sourceVersion = checkedVersion(pkg.version);
    const contentSha256 = await cliContentHash(candidate);
    if (!contentSha256) throw new Error("CLI build payload is missing.");
    const previous = await readJson(path.join(installed, "package.json"));
    const previousBuild = await readJson(
      path.join(installed, "dist", "release.json"),
    );
    const previousVersion = previous ? checkedVersion(previous.version) : null;
    if (
      previousVersion &&
      previousBuild?.version === previousVersion &&
      previousBuild.contentSha256 === contentSha256 &&
      compareVersions(sourceVersion, previousVersion) <= 0 &&
      (await cliContentHash(installed)) === contentSha256
    ) {
      return {
        action: "unchanged",
        ...previousBuild,
        releasePath: path.join(home, previousVersion),
      };
    }
    const versions = (await fs.readdir(home)).filter((name) =>
      versionPattern.test(name),
    );
    if (previousVersion) versions.push(previousVersion);
    const latest = versions.map(checkedVersion).sort(compareVersions).at(-1);
    const version =
      latest && compareVersions(sourceVersion, latest) <= 0
        ? incrementMinorVersion(latest)
        : sourceVersion;
    checkedVersion(version);
    const build = await readJson(
      path.join(candidate, "dist", "build-info.json"),
    );
    if (
      !build?.sourceRevision ||
      !build.builtAt ||
      typeof build.sourceDirty !== "boolean"
    ) {
      throw new Error(
        "CLI build is missing provenance; rebuild before publishing.",
      );
    }
    const release = { schemaVersion: 1, version, ...build, contentSha256 };
    const releasePath = path.join(home, version);
    // Reserve before packing/installing. Failed releases never reuse a version.
    await fs.mkdir(releasePath);
    const serialized = JSON.stringify(release, null, 2) + "\n";
    await fs.writeFile(path.join(releasePath, "release.json"), serialized);
    await fs.writeFile(
      path.join(candidate, "dist", "release.json"),
      serialized,
    );
    pkg.version = version;
    await fs.writeFile(
      path.join(candidate, "package.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
    const packed = JSON.parse(
      (
        await runCaptureChecked(
          "npm",
          ["pack", candidate, "--json", "--pack-destination", releasePath],
          { cwd: sourceRoot },
        )
      ).stdout,
    )[0];
    if (
      !packed?.filename ||
      path.basename(packed.filename) !== packed.filename ||
      packed.files.some(
        ({ path: name }) =>
          name.startsWith("src/") || name.startsWith("node_modules/"),
      )
    ) {
      throw new Error("Unexpected contents in packed CLI release.");
    }
    await runChecked(
      "npm",
      [
        "install",
        "-g",
        "--prefix",
        plan.prefix,
        path.join(releasePath, packed.filename),
      ],
      { cwd: sourceRoot },
    );
    const installedBuild = await readJson(
      path.join(installed, "dist", "release.json"),
    );
    const installedPackage = await readJson(
      path.join(installed, "package.json"),
    );
    if (
      installedPackage?.version !== version ||
      JSON.stringify(installedBuild) !== JSON.stringify(release) ||
      (await cliContentHash(installed)) !== contentSha256
    ) {
      throw new Error(
        "Installed CLI does not match the versioned release artifact.",
      );
    }
    await fs.writeFile(
      path.join(releasePath, "installed.json"),
      JSON.stringify({ installedAt: new Date().toISOString() }) + "\n",
    );
    return { action: "updated", ...release, releasePath };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
