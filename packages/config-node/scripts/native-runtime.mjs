import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Every relocated runtime keeps the kernel lock addon and its resolver beside its bundle.
export function copyNativeLockRuntime(outputDir) {
  const requireFromConfiguration = createRequire(
    new URL("../package.json", import.meta.url),
  );
  copyPackage(
    "fs-native-extensions",
    requireFromConfiguration,
    path.join(outputDir, "node_modules"),
  );
}

function copyPackage(name, resolveFrom, modulesDir) {
  let source = path.dirname(resolveFrom.resolve(name));
  let manifest;
  for (;;) {
    try {
      manifest = JSON.parse(
        readFileSync(path.join(source, "package.json"), "utf8"),
      );
      if (manifest.name === name) break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(source);
    if (parent === source)
      throw new Error(`Cannot find package root for ${name}`);
    source = parent;
  }
  const target = path.join(modulesDir, name);
  mkdirSync(modulesDir, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (entry) => path.basename(entry) !== "node_modules",
  });
  const requireFromPackage = createRequire(path.join(source, "package.json"));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyPackage(
      dependency,
      requireFromPackage,
      path.join(target, "node_modules"),
    );
  }
}
