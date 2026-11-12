import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** A frozen, hoisted install produces a portable tree without Windows junctions. */
export function prepareWindowsWhistle(repoRoot, targetDir, pnpmEntry) {
  const require = createRequire(
    path.join(repoRoot, "packages/config-node/package.json"),
  );
  const yaml = require("yaml");
  const manifest = JSON.parse(
    readFileSync(
      path.join(repoRoot, "packages/whistle-runtime/package.json"),
      "utf8",
    ),
  );
  const workspace = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const lock = yaml.parse(
    readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"),
  );
  const importer = lock.importers?.["packages/whistle-runtime"];
  if (!importer)
    throw new Error("Whistle importer is missing from the workspace lockfile");
  // Keep the exact resolved graph, integrity hashes and patch policy. Only the
  // selected importer's location changes; no dependency resolution is allowed.
  lock.importers = { ".": importer };
  manifest.pnpm = {
    overrides: workspace.pnpm?.overrides,
    patchedDependencies: workspace.pnpm?.patchedDependencies,
  };
  mkdirSync(targetDir, { recursive: true });
  for (const file of Object.values(manifest.pnpm.patchedDependencies ?? {})) {
    const source = path.resolve(repoRoot, file);
    const relative = path.relative(repoRoot, source);
    if (
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Package patch must be inside the workspace");
    const target = path.join(targetDir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  writeFileSync(
    path.join(targetDir, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  writeFileSync(path.join(targetDir, "pnpm-lock.yaml"), yaml.stringify(lock));
  execFileSync(
    process.execPath,
    [
      pnpmEntry,
      "--dir",
      targetDir,
      "--ignore-workspace",
      "install",
      "--frozen-lockfile",
      "--prod",
      "--node-linker=hoisted",
      "--ignore-scripts",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  // Catch a broken relocated dependency graph before producing an installer.
  execFileSync(
    process.execPath,
    [
      "-e",
      "require(process.argv[1])",
      path.join(targetDir, "node_modules/whistle"),
    ],
    { stdio: "inherit" },
  );
}
