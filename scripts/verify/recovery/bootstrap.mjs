import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, repoRoot, entry, ...args] = process.argv.slice(2);
assert(
  root && repoRoot && entry && [root, repoRoot, entry].every(path.isAbsolute),
);
const context = JSON.parse(
  await readFile(path.join(root, "verification-context.json"), "utf8"),
);
assert.equal(context.configRoot, root);
os.tmpdir = () => root;
// Isolate home-based session discovery and Stable registration in every fixture.
const home = path.join(root, "home");
const user = os.userInfo();
os.homedir = () => home;
os.userInfo = () => ({ ...user, homedir: home });
syncBuiltinESMExports();
const configPath = path.join(repoRoot, "packages/config-node/src/index.ts");
const require = createRequire(path.join(repoRoot, "backend/package.json"));
require("tsx/cjs/api")
  .require(configPath, import.meta.url)
  .initializeConfiguration(context);
(await import(pathToFileURL(configPath).href)).initializeConfiguration(context);
process.argv = [process.execPath, entry, ...args];
delete process.env.RUNWEAVE_ACTIVITY_WORKER_ENTRY;
delete process.env.RUNWEAVE_EVOLUTION_WORKER_ENTRY;
await import(pathToFileURL(entry).href);
