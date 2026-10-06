// Integration check: real electron-builder tar + compression, then system tar.
// Optional argv[2] selects an archive module for before/after patch verification.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const electronRequire = createRequire(
  new URL("../../../electron/package.json", import.meta.url),
);
const builderRequire = createRequire(
  electronRequire.resolve("electron-builder"),
);
const archiveModule = process.argv[2]
  ? path.resolve(process.argv[2])
  : builderRequire.resolve("app-builder-lib/out/targets/archive.js");
const requireArchive = createRequire(archiveModule);
const { tar: archive } = requireArchive(archiveModule);
const tar = requireArchive("tar");
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "runweave-linux-archive-"),
);
console.log(
  JSON.stringify({ scratch, archiveModule, platform: process.platform }),
);
const input = path.join(scratch, "linux-unpacked");
const funding = (version) =>
  `resources/whistle-runtime/node_modules/.pnpm/side-channel-list@${version}/node_modules/side-channel-list/.github/FUNDING.yml`;
const first = path.join(input, funding("1.0.0"));
const second = path.join(input, funding("1.0.1"));
fs.mkdirSync(path.dirname(first), { recursive: true });
fs.mkdirSync(path.dirname(second), { recursive: true });
fs.writeFileSync(first, "github: ljharb\n", { mode: 0o644 });
fs.linkSync(first, second);
fs.writeFileSync(path.join(input, "runweave"), "#!/bin/sh\nexit 0\n", {
  mode: 0o755,
});
fs.linkSync(path.join(input, "runweave"), path.join(input, "runweave-helper"));
fs.writeFileSync(path.join(input, "private-data"), "fixture\n", {
  mode: 0o600,
});
fs.writeFileSync(path.join(input, "empty"), "");
fs.linkSync(path.join(input, "empty"), path.join(input, "empty-link"));
const modules = path.join(input, "resources/whistle-runtime/node_modules");
fs.symlinkSync(
  ".pnpm/side-channel-list@1.0.0/node_modules/side-channel-list",
  path.join(modules, "side-channel-list"),
);
fs.symlinkSync("runweave", path.join(input, "launcher"));

function compareTrees(source, destination) {
  const expected = fs.lstatSync(source);
  const actual = fs.lstatSync(destination);
  assert.equal(actual.mode & 0o7777, expected.mode & 0o7777, destination);
  if (expected.isSymbolicLink()) {
    assert.ok(actual.isSymbolicLink(), destination);
    assert.equal(fs.readlinkSync(destination), fs.readlinkSync(source));
    assert.ok(fs.existsSync(fs.realpathSync(destination)), destination);
  } else if (expected.isDirectory()) {
    assert.ok(actual.isDirectory(), destination);
    const children = fs.readdirSync(source).sort();
    assert.deepEqual(fs.readdirSync(destination).sort(), children, destination);
    for (const child of children) {
      compareTrees(path.join(source, child), path.join(destination, child));
    }
  } else {
    assert.ok(actual.isFile(), destination);
    assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source));
  }
}

for (let iteration = 1; iteration <= 3; iteration += 1) {
  const work = path.join(scratch, String(iteration));
  const extracted = path.join(work, "extracted");
  fs.mkdirSync(extracted, { recursive: true });
  const prefix = "Runweave-repro-linux-x64";
  const output = path.join(work, `${prefix}.tar.gz`);
  const originalLstat = fs.lstat;
  let delayed = 0;
  // Force the earlier queued inode alias to finish stat after the later alias.
  // Only callback timing changes; real filesystem metadata/content is retained.
  fs.lstat = function (filename, ...args) {
    const callback = args.pop();
    return originalLstat.call(this, filename, ...args, (...result) => {
      if (filename === first) {
        delayed += 1;
        setTimeout(() => callback(...result), 200);
      } else {
        callback(...result);
      }
    });
  };
  try {
    await archive("normal", "tar.gz", output, input, false, {
      getTempFile: async () => path.join(work, "archive.tar"),
    });
  } finally {
    fs.lstat = originalLstat;
  }
  assert.ok(
    delayed > 0,
    "The race injection must exercise the real tar reader",
  );
  const entries = [];
  await tar.t({
    file: output,
    onentry: (entry) =>
      entries.push({
        path: entry.path,
        type: entry.type,
        linkpath: entry.linkpath,
      }),
  });
  fs.writeFileSync(
    path.join(work, "entries.json"),
    JSON.stringify(entries, null, 2),
  );
  const seen = new Set();
  const forwardLinks = [];
  const hardlinks = entries.filter((entry) => entry.type === "Link");
  for (const entry of entries) {
    if (entry.type === "Link" && !seen.has(entry.linkpath))
      forwardLinks.push(entry);
    seen.add(entry.path);
  }
  const result = spawnSync("tar", ["-xzf", output, "-C", extracted], {
    encoding: "utf8",
  });
  fs.writeFileSync(path.join(work, "extract.log"), result.stderr ?? "");
  console.log(
    JSON.stringify({
      iteration,
      delayed,
      entries: entries.length,
      hardlinks: hardlinks.length,
      forwardLinks,
      extractionExit: result.status,
    }),
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(forwardLinks, [], "Hardlink targets must precede links");
  assert.equal(hardlinks.length, 3, "Keep hardlink deduplication");
  assert.equal(
    entries.filter((entry) => entry.type === "SymbolicLink").length,
    2,
  );
  compareTrees(input, path.join(extracted, prefix));
  for (const entry of hardlinks) {
    const link = fs.statSync(path.join(extracted, entry.path));
    const target = fs.statSync(path.join(extracted, entry.linkpath));
    assert.equal(link.ino, target.ino, entry.path);
    assert.equal(link.dev, target.dev, entry.path);
  }
}
console.log(
  "PASS: 3 archives/extractions; backward hardlinks, symlinks, contents and modes",
);
