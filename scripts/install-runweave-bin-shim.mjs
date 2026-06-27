import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const binDir = path.join(os.homedir(), ".runweave", "bin");
const target = path.join(binDir, "rw");
const cliEntry = path.resolve(args.cliEntry ?? "packages/runweave-cli/dist/index.js");
const appServerHome = path.resolve(
  expandHome(args.home ?? path.join(os.homedir(), ".runweave", "app-server-test")),
);

mkdirSync(binDir, { recursive: true });
writeFileSync(
  target,
  `#!/usr/bin/env bash
set -euo pipefail
export RUNWEAVE_APP_SERVER_HOME="${appServerHome}"
exec "${process.execPath}" "${cliEntry}" "$@"
`,
);
chmodSync(target, 0o755);

console.log(`[runweave-bin] installed shim: ${target}`);
console.log(`[runweave-bin] cli entry: ${cliEntry}`);
console.log(`[runweave-bin] app-server home: ${appServerHome}`);

function parseArgs(argv) {
  const parsed = {
    cliEntry: null,
    home: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli-entry") {
      parsed.cliEntry = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--cli-entry=")) {
      parsed.cliEntry = arg.slice("--cli-entry=".length);
      continue;
    }
    if (arg === "--home") {
      parsed.home = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--home=")) {
      parsed.home = arg.slice("--home=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function expandHome(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
