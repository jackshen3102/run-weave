import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  artifactRoot,
  betterSqliteVersion,
  electronVersion,
  repoRoot,
  stagingAppDir,
} from "./activity-sqlite-runtime-paths.mjs";

const packageDir = path.join(
  repoRoot,
  "backend",
  "node_modules",
  "better-sqlite3",
);
const installedVersion = JSON.parse(
  readFileSync(path.join(packageDir, "package.json"), "utf8"),
).version;
if (installedVersion !== betterSqliteVersion) {
  throw new Error(
    `Expected better-sqlite3 ${betterSqliteVersion}, found ${installedVersion}; run pnpm install --frozen-lockfile`,
  );
}
const prebuildPlatform =
  process.platform === "linux" &&
  !process.report.getReport().header.glibcVersionRuntime
    ? "linuxmusl"
    : process.platform;
const targetPrebuild = `${prebuildPlatform}-${process.arch}.node`;
if (!existsSync(path.join(packageDir, "prebuilds", targetPrebuild))) {
  throw new Error(`better-sqlite3 prebuild is missing: ${targetPrebuild}`);
}

rmSync(artifactRoot, { recursive: true, force: true });
const stagingNodeModules = path.join(stagingAppDir, "node_modules");
mkdirSync(stagingNodeModules, { recursive: true });
cpSync(packageDir, path.join(stagingNodeModules, "better-sqlite3"), {
  recursive: true,
  dereference: true,
  filter: (entry) => {
    const relative = path.relative(packageDir, entry);
    return (
      !relative ||
      relative === "lib" ||
      relative.startsWith(`lib${path.sep}`) ||
      relative === "prebuilds" ||
      relative === path.join("prebuilds", targetPrebuild) ||
      relative === "package.json" ||
      relative === "LICENSE"
    );
  },
});
console.log(
  `[activity-sqlite] prepared ${electronVersion}/${process.platform}/${process.arch}`,
);
