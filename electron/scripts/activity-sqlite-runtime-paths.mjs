import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const electronDir = path.resolve(scriptDir, "..");
export const repoRoot = path.resolve(electronDir, "..");
const electronPackage = JSON.parse(
  readFileSync(path.join(electronDir, "package.json"), "utf8"),
);
const backendPackage = JSON.parse(
  readFileSync(path.join(repoRoot, "backend", "package.json"), "utf8"),
);
export const electronVersion = String(electronPackage.devDependencies.electron).replace(/^\D+/, "");
export const betterSqliteVersion = String(backendPackage.dependencies["better-sqlite3"]).replace(/^\D+/, "");
export const runtimeKey = `electron-${electronVersion}-${process.platform}-${process.arch}`;
const configuredArtifactRoot =
  process.env.RUNWEAVE_ACTIVITY_SQLITE_ARTIFACT_ROOT?.trim();
export const artifactRoot = configuredArtifactRoot
  ? path.resolve(configuredArtifactRoot)
  : path.join(
      repoRoot,
      ".native-artifacts",
      "better-sqlite3",
      runtimeKey,
    );
export const stagingAppDir = path.join(artifactRoot, "staging-app");
export const resourcesBackendDir = path.join(electronDir, "dist", "backend");
