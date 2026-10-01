import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Linux desktop packaging requires a Linux x64 host");
}
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dir")) {
  throw new Error("Supported option: --dir (unpacked application only)");
}
// Dedicated staging keeps this opt-in build away from macOS release output.
// Unlike the release wrapper defaults, local Linux builds never bump versions.
const result = spawnSync(
  process.execPath,
  [
    "scripts/electron/dist-retry.mjs",
    "--config",
    "electron-builder.linux.yml",
    "--linux",
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
        path.resolve("electron/.linux-build"),
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
