#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const cliPackagePath = path.join(
  workspaceRoot,
  "packages",
  "runweave-cli",
  "package.json",
);

const raw = fs.readFileSync(cliPackagePath, "utf8");
const pkg = JSON.parse(raw);

if (typeof pkg.version !== "string") {
  throw new Error(
    "packages/runweave-cli/package.json version must be a string",
  );
}

const parts = pkg.version.split(".").map((item) => Number(item));
if (parts.length !== 3 || parts.some((item) => Number.isNaN(item))) {
  throw new Error(`Unsupported version format: ${pkg.version}`);
}

const [major, minor] = parts;
const nextVersion = `${major}.${minor + 1}.0`;

if (nextVersion === pkg.version) {
  console.log("Runweave CLI version unchanged.");
  process.exit(0);
}

pkg.version = nextVersion;
fs.writeFileSync(cliPackagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Runweave CLI version bumped to ${nextVersion}`);
