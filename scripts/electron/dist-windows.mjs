import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows desktop packaging requires a Windows x64 host");
}
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dir"))
  throw new Error("Supported option: --dir");
// Dependencies are installed with --ignore-scripts: native addons already ship
// prebuilds, and the preview does not require a Visual Studio toolchain.
const require = createRequire(
  new URL("../../electron/package.json", import.meta.url),
);
const electronPackage = path.dirname(require.resolve("electron/package.json"));
if (!existsSync(path.join(electronPackage, "dist", "electron.exe"))) {
  const installed = spawnSync(
    process.execPath,
    [path.join(electronPackage, "install.js")],
    { stdio: "inherit" },
  );
  if (installed.error) throw installed.error;
  if (installed.status !== 0) process.exit(installed.status ?? 1);
}
const result = spawnSync(
  process.execPath,
  [
    "scripts/electron/dist-retry.mjs",
    "--config",
    "electron-builder.windows.yml",
    "--win",
    "--x64",
    "--publish",
    "never",
    ...args,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RUNWEAVE_SKIP_ELECTRON_VERSION_BUMP: "true",
      RUNWEAVE_ELECTRON_BUILD_ROOT:
        process.env.RUNWEAVE_ELECTRON_BUILD_ROOT ||
        path.resolve("electron/.windows-build"),
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
