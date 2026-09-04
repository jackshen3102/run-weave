import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();
const releaseDir = path.join(workspaceRoot, "electron", "release");
const outputDir = path.join(workspaceRoot, ".local-updates", "updates", "mac");
const requiredArtifacts = [
  "latest-mac.yml",
];

async function ensureRequiredArtifacts() {
  for (const file of requiredArtifacts) {
    await fs.access(path.join(releaseDir, file));
  }
}

async function collectArtifacts() {
  const entries = await fs.readdir(releaseDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name === "latest-mac.yml" ||
        name.endsWith(".zip") ||
        name.endsWith(".dmg") ||
        name.endsWith(".blockmap"),
    );
}

async function copyArtifacts(files) {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  for (const file of files) {
    await fs.copyFile(
      path.join(releaseDir, file),
      path.join(outputDir, file),
    );
  }
}

await ensureRequiredArtifacts();
const artifacts = await collectArtifacts();
await copyArtifacts(artifacts);

console.log(`[local-updates] published ${artifacts.length} artifact(s) to ${outputDir}`);
