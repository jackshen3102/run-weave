import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuildInfo } from "../lib/build-info.mjs";

const require = createRequire(
  new URL("../../packages/runweave-cli/package.json", import.meta.url),
);
const { tryLock } = require("fs-native-extensions");
const header = /^\/\* runweave:build-info \*\/[^\n]*\n/;
const htmlHeader = /<script data-runweave-build-info>[^<]*<\/script>\n?/g;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function checkedVersion(value) {
  if (
    !versionPattern.test(value ?? "") ||
    value.split(".").some((part) => !Number.isSafeInteger(Number(part)))
  )
    throw new Error(`Invalid component version: ${value}`);
  return value;
}
function compare(a, b) {
  const right = b.split(".").map(Number);
  for (const [index, part] of a.split(".").map(Number).entries()) {
    if (part !== right[index]) return part - right[index];
  }
  return 0;
}
function increment(version) {
  const [major, minor] = version.split(".").map(Number);
  return checkedVersion(`${major}.${minor + 1}.0`);
}
async function readJson(file, missing) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return missing;
    throw error;
  }
}

// Only our generated identity and debug maps are excluded. Dependencies,
// workers, native binaries, assets and runtime configuration remain inputs.
function contentBytes(name, bytes) {
  if (/\.(?:c?js|mjs)$/.test(name))
    return Buffer.from(bytes.toString("utf8").replace(header, ""));
  if (/\.html$/.test(name))
    return Buffer.from(bytes.toString("utf8").replace(htmlHeader, ""));
  return bytes;
}
export async function componentContentHash(roots, descriptor = {}) {
  const hash = createHash("sha256").update(JSON.stringify(descriptor));
  let count = 0;
  async function visit(root, relative = "") {
    const entries = await fs.readdir(path.join(root.directory, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const name = path.posix.join(relative, entry.name);
      if (
        root.exclude?.some(
          (excluded) => name === excluded || name.startsWith(`${excluded}/`),
        )
      )
        continue;
      if (entry.isDirectory()) {
        await visit(root, name);
        continue;
      }
      if (
        name.endsWith(".map") ||
        ["build-info.json", "release.json"].includes(name)
      )
        continue;
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(path.join(root.directory, name));
        const resolved = path.resolve(
          root.directory,
          path.dirname(name),
          target,
        );
        const relativeTarget = path.relative(
          path.resolve(root.directory),
          resolved,
        );
        if (
          path.isAbsolute(target) ||
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${path.sep}`)
        )
          throw new Error(
            `Component symlink escapes artifact: ${root.name}/${name}`,
          );
        hash.update(`${root.name}/${name}\0symlink\0${target}\0`);
        count++;
        continue;
      }
      if (!entry.isFile())
        throw new Error(
          `Unsupported component artifact entry: ${root.name}/${name}`,
        );
      const bytes = contentBytes(
        name,
        await fs.readFile(path.join(root.directory, name)),
      );
      const executable =
        (await fs.stat(path.join(root.directory, name))).mode & 0o111;
      hash
        .update(`${root.name}/${name}\0${executable}\0${bytes.length}\0`)
        .update(bytes);
      count++;
    }
  }
  for (const root of [...roots].sort((a, b) => a.name.localeCompare(b.name)))
    await visit(root);
  if (!count) throw new Error("Cannot publish an empty component artifact");
  return hash.digest("hex");
}

async function writeIdentity(file, info, html = false) {
  const original = await fs.readFile(file, "utf8");
  const serialized = JSON.stringify(info).replaceAll("<", "\\u003c");
  if (html) {
    const content = original.replace(htmlHeader, "");
    if (!content.includes("<head>"))
      throw new Error(`Missing HTML head: ${file}`);
    await fs.writeFile(
      file,
      content.replace(
        "<head>",
        `<head><script data-runweave-build-info>var __RUNWEAVE_BUILD_INFO__=${serialized};</script>\n`,
      ),
    );
  } else {
    const hadHeader = header.test(original);
    const content = original.replace(header, "");
    const strict = /^["']use strict["'];/.test(content) ? '"use strict";' : "";
    await fs.writeFile(
      file,
      `/* runweave:build-info */${strict}var __RUNWEAVE_BUILD_INFO__=${serialized};\n${content}`,
    );
    const map = await readJson(`${file}.map`, null);
    if (map && !hadHeader) {
      map.mappings = `;${map.mappings}`;
      await fs.writeFile(`${file}.map`, JSON.stringify(map));
    }
  }
}

/** Finalize a successful build as an immutable, locally versioned artifact.
 * Installers ship this identity unchanged; starting a process never allocates it.
 */
export async function publishComponentArtifact({
  component,
  packageDirectory,
  roots,
  metadataFile,
  entries = [],
  htmlEntries = [],
  descriptor = {},
  minimumVersion,
  registryRoot = process.env.RUNWEAVE_COMPONENT_RELEASE_REGISTRY ??
    path.join(os.homedir(), ".runweave", "component-releases"),
}) {
  if (!/^[a-z][a-z0-9-]*$/.test(component))
    throw new Error("Invalid component name");
  const build = createBuildInfo(packageDirectory);
  checkedVersion(build.version);
  if (minimumVersion) checkedVersion(minimumVersion);
  const contentSha256 = await componentContentHash(roots, descriptor);
  const directory = path.join(registryRoot, component);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await fs.open(path.join(directory, "publish.lock"), "a+", 0o600);
  try {
    const deadline = Date.now() + 10_000;
    while (!tryLock(lock.fd)) {
      if (Date.now() >= deadline)
        throw new Error(`Component release is busy: ${component}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const ledgerPath = path.join(directory, "releases.json");
    const ledger = await readJson(ledgerPath, {
      schemaVersion: 1,
      releases: [],
    });
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.releases))
      throw new Error(`Invalid release ledger: ${component}`);
    const versions = new Set();
    for (const release of ledger.releases) {
      checkedVersion(release.version);
      if (
        !/^[a-f0-9]{64}$/.test(release.contentSha256) ||
        versions.has(release.version)
      )
        throw new Error(`Corrupt release ledger: ${component}`);
      versions.add(release.version);
    }
    const previous = ledger.releases.find(
      (release) => release.contentSha256 === contentSha256,
    );
    let info = previous
      ? { ...build, version: previous.version, contentSha256 }
      : null;
    if (!info) {
      const latest = [...versions, ...(minimumVersion ? [minimumVersion] : [])]
        .sort(compare)
        .at(-1);
      const version =
        latest && compare(build.version, latest) <= 0
          ? increment(latest)
          : build.version;
      info = { ...build, version, contentSha256 };
    }
    for (const file of entries) await writeIdentity(file, info);
    for (const file of htmlEntries) await writeIdentity(file, info, true);
    await fs.writeFile(metadataFile, JSON.stringify(info, null, 2) + "\n");
    if (!previous) {
      ledger.releases.push(info);
      const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(ledger, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, ledgerPath);
    }
    console.log(
      `[component-release] ${component} ${info.version} ${previous ? "unchanged" : "published"} ${contentSha256.slice(0, 12)}`,
    );
    return info;
  } finally {
    await lock.close();
  }
}
