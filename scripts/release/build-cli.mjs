import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const output = path.resolve(
  process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ??
    path.join(repo, ".runtime-artifacts/cli/package"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const result = spawnSync(process.execPath, ["scripts/bundle.mjs"], {
  cwd: path.join(repo, "packages/runweave-cli"),
  stdio: "inherit",
  env: {
    ...process.env,
    RUNWEAVE_CLI_BUNDLE_OUTFILE: path.join(output, "dist/index.js"),
  },
});
if (result.status !== 0) throw new Error("CLI distribution build failed");
// npm explicitly includes bundled production dependencies; no registry build scripts are needed.
cpSync(
  path.join(output, "dist/node_modules"),
  path.join(output, "node_modules"),
  { recursive: true },
);
rmSync(path.join(output, "dist/node_modules"), { recursive: true });
const source = JSON.parse(
  readFileSync(path.join(repo, "packages/runweave-cli/package.json"), "utf8"),
);
const pkg = {
  name: source.name,
  version: source.version,
  license: source.license,
  type: "commonjs",
  description:
    "Runweave control-plane CLI and standalone Server lifecycle management",
  bin: source.bin,
  files: ["dist"],
  engines: { node: ">=20" },
  dependencies: {
    "fs-native-extensions": source.dependencies["fs-native-extensions"],
  },
  bundleDependencies: ["fs-native-extensions"],
};
writeFileSync(
  path.join(output, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);
console.log(`[cli-release] ${output}`);
