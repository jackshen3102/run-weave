import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function commandExists(command) {
  return commandPath(command) !== null;
}

function commandPath(command) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    for (const suffix of suffixes) {
      const file = path.join(directory, command + suffix);
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch { /* next PATH entry */ }
    }
  }
  return null;
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
  const resolved = process.platform === "win32" ? commandPath(command) : null;
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    // cmd expands percent variables even inside quotes. Refuse unrepresentable argv.
    const values = [resolved, ...commandArgs];
    if (values.some(value => /["%\r\n]/.test(value)))
      throw new Error("Cannot pass quotes, percent signs or line breaks to a Windows Agent command shim");
    return spawnSync("cmd.exe", ["/d", "/v:off", "/s", "/c",
      `"${values.map(value => `"${value}"`).join(" ")}"`], {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      encoding: "utf8",
      stdio: options.stdio || "pipe",
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(command, commandArgs, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
}

export function runCapture(command, commandArgs, options = {}) {
  const result = runResult(command, commandArgs, {
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

export function assertFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required file does not exist: ${filePath}`);
  }
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

export const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
