import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const electronPackagePath = path.join(
  workspaceRoot,
  "electron",
  "package.json",
);

const raw = fs.readFileSync(electronPackagePath, "utf8");
const pkg = JSON.parse(raw);

if (typeof pkg.version !== "string") {
  throw new Error("electron/package.json version must be a string");
}

const parts = pkg.version.split(".").map((item) => Number(item));
if (parts.length !== 3 || parts.some((item) => Number.isNaN(item))) {
  throw new Error(`Unsupported version format: ${pkg.version}`);
}

const [major, minor] = parts;
const nextVersion = `${major}.${minor + 1}.0`;

if (nextVersion === pkg.version) {
  console.log("Electron version unchanged.");
  process.exit(0);
}

pkg.version = nextVersion;
fs.writeFileSync(electronPackagePath, `${JSON.stringify(pkg, null, 2)}\n`);

try {
  const relativePath = path.relative(workspaceRoot, electronPackagePath);
  execSync(`git add "${relativePath}"`, {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  execSync(
    `git commit --only "${relativePath}" -m "chore(electron): bump version to ${nextVersion}"`,
    {
      cwd: workspaceRoot,
      stdio: "inherit",
    },
  );
} catch (error) {
  console.warn("Git commit failed; version was still updated.");
  console.warn(error?.message ?? error);
}
