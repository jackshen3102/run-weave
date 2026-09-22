#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
if (args.length !== 1 || args[0].startsWith("-")) {
  console.error("Usage: pnpm toolkit:validate -- <skill-directory>");
  process.exit(2);
}

const validator = path.resolve(
  process.env.CODEX_HOME || path.join(homedir(), ".codex"),
  "skills/.system/skill-creator/scripts/quick_validate.py",
);
try {
  accessSync(validator, constants.R_OK);
} catch (error) {
  console.error(
    `[toolkit-validate] 校验未执行：无法读取官方校验器 ${validator} (${error.code})。`,
  );
  process.exit(2);
}

// Only normal completion of the official CLI emits this marker. uv startup,
// dependency resolution and Python exceptions must not look like invalid skills.
const completed = "\n__TOOLKIT_SKILL_VALIDATOR_COMPLETED__\n";
const launcher = `
import os
import runpy
import sys
validator, skill = sys.argv[1:]
sys.argv = [validator, skill]
sys.path[0] = os.path.dirname(validator)
try:
    runpy.run_path(validator, run_name="__main__")
except SystemExit:
    sys.stderr.write(${JSON.stringify(completed)})
    raise
else:
    sys.stderr.write(${JSON.stringify(completed)})
`;
const result = spawnSync(
  "uv",
  [
    "run",
    "--no-project",
    "--isolated",
    "--no-env-file",
    "--with",
    "pyyaml",
    "python",
    "-c",
    launcher,
    validator,
    path.resolve(args[0]),
  ],
  { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
);
const stderr = result.stderr || "";
process.stdout.write(result.stdout || "");
process.stderr.write(stderr.replace(completed, ""));
if (result.error || result.signal || !stderr.includes(completed)) {
  const reason = result.error?.code || result.signal || `exit ${result.status}`;
  console.error(
    `[toolkit-validate] 校验未完成：启动、依赖准备或校验器执行异常 (${reason})，不能据此判定技能不合格。请检查 uv、Python、依赖源及以上错误。`,
  );
  process.exitCode = 2;
} else {
  process.exitCode = result.status;
}
