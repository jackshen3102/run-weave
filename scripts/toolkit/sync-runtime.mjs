import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function commandExists(command) {
  const result = spawnSync(
    "bash",
    ["-lc", `command -v ${shellQuote(command)}`],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  return result.status === 0;
}

export function run(command, commandArgs, options = {}) {
  log(`$ ${[command, ...commandArgs].map(shellQuote).join(" ")}`);
  const result = runResult(command, commandArgs, {
    ...options,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

export function runOptional(command, commandArgs, options = {}) {
  log(`$ ${[command, ...commandArgs].map(shellQuote).join(" ")} || true`);
  const result = runResult(command, commandArgs, options);
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) {
      log(output);
    }
  }
}

export function runResult(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
}

export function runCapture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    if (!options.quiet) {
      process.stderr.write(result.stderr || "");
      process.stdout.write(result.stdout || "");
    }
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout;
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function assertFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required file does not exist: ${filePath}`);
  }
}

export function getBasePluginVersion(version) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("plugin.json version must be a non-empty string.");
  }
  return version.split("+codex.")[0];
}

export function formatCodexTimestamp(date) {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  return parts
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join("");
}

export function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function log(message) {
  console.log(`[toolkit-sync] ${message}`);
}

export const repoRoot = runCapture("git", ["rev-parse", "--show-toplevel"], {
  quiet: true,
}).trim();
