/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS bootstrap must load the immutable CJS runtime without ESM resolution into npm replacement paths. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
function materialize(installed, home) {
  {
    const platform = `${process.platform}-${process.arch}`;
    let native;
    try {
      native = path.dirname(
        createRequire(path.join(installed, "package.json")).resolve(
          `@runweave/server-${platform}/package.json`,
        ),
      );
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
      // The source builder emits the same package next to its platform payload.
      native = path.resolve(installed, "..", platform);
    }
    const pkg = JSON.parse(
      fs.readFileSync(path.join(installed, "package.json"), "utf8"),
    );
    const nativePkg = JSON.parse(
      fs.readFileSync(path.join(native, "package.json"), "utf8"),
    );
    if (
      pkg.name !== "@runweave/server" ||
      nativePkg.name !== `@runweave/server-${platform}` ||
      pkg.version !== nativePkg.version
    )
      throw new Error("Server/platform package identity mismatch");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(native, "manifest.json"), "utf8"),
    );
    if (
      manifest.managementApiVersion !== 1 ||
      manifest.version !== pkg.version ||
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch ||
      manifest.nodeModuleAbi !== process.versions.modules
    )
      throw new Error("Platform package does not match this Node ABI");
    if (
      process.platform === "linux" &&
      !process.report.getReport().header.glibcVersionRuntime
    )
      throw new Error("Linux glibc is required");
    const releases = path.join(home, "releases");
    fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
    const stage = fs.mkdtempSync(path.join(releases, ".stage-"));
    try {
      fs.cpSync(path.join(native, "payload"), stage, { recursive: true });
      const archive = path.join(native, "native.tar.gz");
      const entries = execFileSync("tar", ["-tzf", archive], {
        encoding: "utf8",
      })
        .trim()
        .split("\n");
      if (
        entries.some(
          (entry) => path.isAbsolute(entry) || entry.split("/").includes(".."),
        )
      )
        throw new Error("Unsafe native archive");
      execFileSync("tar", ["-xzf", archive, "-C", stage]);
      fs.copyFileSync(
        path.join(native, "manifest.json"),
        path.join(stage, "server-manifest.json"),
      );
      for (const file of manifest.files) {
        if (path.isAbsolute(file.path) || file.path.split("/").includes(".."))
          throw new Error("Unsafe release path");
        const bytes = fs.readFileSync(path.join(stage, file.path));
        if (
          bytes.length !== file.size ||
          crypto.createHash("sha256").update(bytes).digest("hex") !==
            file.sha256
        )
          throw new Error(`Release checksum mismatch: ${file.path}`);
      }
      const release = path.join(
        releases,
        `${manifest.version}-${crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16)}`,
      );
      if (!fs.existsSync(release)) fs.renameSync(stage, release);
      return release;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
}
module.exports = { materialize };
