#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Python's kernel flock serializes transitions without a second stale lock protocol.
const result = spawnSync(
  "python3",
  [
    "-B",
    fileURLToPath(new URL("./pool.py", import.meta.url)),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
