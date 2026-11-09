import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Git's distribution inputs exclude local browser logs, Python caches and other ignored output.
export function toolkitRelease(root, { packaged = false } = {}) {
  const pluginRoot = path.join(root, "plugins/toolkit");
  const result = packaged ? {
    status: 0,
    stdout: readdirSync(pluginRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .join("\0"),
  } : spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "plugins/toolkit",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error(`Cannot enumerate Toolkit inputs: ${result.stderr}`);
  const files = [...new Set(result.stdout.split("\0").filter(Boolean))]
    .sort()
    .flatMap((name) => {
      if (name.split("/").includes("__pycache__") || /\.py[co]$/.test(name))
        return [];
      const source = path.join(root, name);
      if (!existsSync(source)) return [];
      const stat = lstatSync(source);
      if (!stat.isFile())
        throw new Error(
          `Toolkit distribution input must be a regular file: ${name}`,
        );
      return [
        {
          name: name.slice("plugins/toolkit/".length),
          content: readFileSync(source),
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
        },
      ];
    });
  const manifest = files.find(
    (file) => file.name === ".codex-plugin/plugin.json",
  );
  if (!manifest) throw new Error("Toolkit manifest is missing.");
  const metadata = JSON.parse(manifest.content);
  const baseVersion = metadata.version?.split("+codex.")[0];
  if (!baseVersion) throw new Error("Toolkit manifest version is missing.");
  metadata.version = baseVersion;
  manifest.content = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(file.name)
      .update("\0")
      .update(String(file.mode & 0o111))
      .update("\0")
      .update(file.content)
      .update("\0");
  }
  const digest = hash.digest("hex");
  const version = `${baseVersion}+codex.${digest}`;
  metadata.version = version;
  manifest.content = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  return { files, digest, version };
}

export function packageMatches(directory, files) {
  if (!existsSync(directory)) return false;
  const names = [];
  const visit = (relative = "") => {
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else names.push(name);
    }
  };
  visit();
  if (names.length !== files.length) return false;
  return files.every((file) => {
    const target = path.join(directory, file.name);
    if (!existsSync(target)) return false;
    const stat = lstatSync(target);
    return (
      stat.isFile() &&
      (stat.mode & 0o111) === (file.mode & 0o111) &&
      readFileSync(target).equals(file.content)
    );
  });
}

export function publishToolkitRelease(publishRoot, marketplace, release) {
  const directory = path.join(publishRoot, "releases", release.version);
  if (existsSync(directory)) {
    if (!packageMatches(directory, release.files)) {
      throw new Error(`Immutable Toolkit release has changed: ${directory}`);
    }
  } else {
    const staging = `${directory}.${randomUUID()}.tmp`;
    try {
      for (const file of release.files) {
        const target = path.join(staging, file.name);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.content, { mode: file.mode });
        chmodSync(target, file.mode);
      }
      renameSync(staging, directory);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const entry = marketplace.plugins.find((plugin) => plugin.name === "toolkit");
  if (!entry) throw new Error("Toolkit marketplace entry is missing.");
  const published = {
    ...marketplace,
    plugins: [
      {
        ...entry,
        source: { source: "local", path: `./releases/${release.version}` },
      },
    ],
  };
  const manifest = path.join(publishRoot, ".agents/plugins/marketplace.json");
  const content = `${JSON.stringify(published, null, 2)}\n`;
  if (!existsSync(manifest) || readFileSync(manifest, "utf8") !== content) {
    mkdirSync(path.dirname(manifest), { recursive: true });
    const temporary = `${manifest}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content);
    renameSync(temporary, manifest);
  }
  return directory;
}

export async function lockToolkitSync(codexHome, log) {
  const directory = path.join(
    codexHome,
    "plugins",
    ".runweave-toolkit-sync.lock",
  );
  const ownerFile = path.join(directory, "owner.json");
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  mkdirSync(path.dirname(directory), { recursive: true });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      mkdirSync(directory);
      writeFileSync(ownerFile, owner);
      return () => {
        if (
          existsSync(ownerFile) &&
          readFileSync(ownerFile, "utf8") === owner
        ) {
          rmSync(directory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let previous;
    try {
      previous = readFileSync(ownerFile, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous) {
      const { pid } = JSON.parse(previous);
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (
          error.code === "ESRCH" &&
          existsSync(ownerFile) &&
          readFileSync(ownerFile, "utf8") === previous
        ) {
          rmSync(directory, { recursive: true, force: true });
          continue;
        }
      }
    }
    if (attempt % 15 === 0)
      log(
        "Another worktree is syncing Toolkit; waiting for its installation to finish.",
      );
    await delay(1000);
  }
  throw new Error(`Toolkit sync is still busy: ${directory}`);
}
