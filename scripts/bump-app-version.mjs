import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = path.join(repoRoot, "app", "package.json");
const versionArg = process.argv[2];

function fail(message) {
  console.error(message);
  console.error("Usage: pnpm app:version:bump -- <patch|minor|major|x.y.z>");
  process.exit(1);
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    fail(`Unsupported version format: ${version}`);
  }
  return match.slice(1).map((part) => Number(part));
}

function resolveNextVersion(currentVersion, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    return bump;
  }

  const [major, minor, patch] = parseVersion(currentVersion);
  switch (bump) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      fail(`Unsupported version bump: ${bump ?? ""}`);
  }
}

if (!versionArg) {
  fail("Missing version bump.");
}

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
if (typeof pkg.version !== "string") {
  fail("app/package.json version must be a string.");
}

const nextVersion = resolveNextVersion(pkg.version, versionArg);
if (nextVersion === pkg.version) {
  console.log(`Runweave App version unchanged: ${pkg.version}`);
  process.exit(0);
}

pkg.version = nextVersion;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Runweave App version bumped to ${nextVersion}`);
