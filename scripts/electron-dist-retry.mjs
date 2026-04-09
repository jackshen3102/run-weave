import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const ELECTRON_DIR = path.join(ROOT, "electron");
const ELECTRON_RELEASE_DIR = path.join(ELECTRON_DIR, "release");
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export function isRetriableHdiutilResizeBusyError(output) {
  return (
    /hdiutil:\s*resize:\s*failed\./i.test(output) &&
    /(?:resource temporarily unavailable|资源暂时不可用)\s*\(35\)/i.test(output)
  );
}

export async function runWithRetries({
  run,
  shouldRetry,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  waitMs = DEFAULT_WAIT_MS,
  wait = defaultWait,
  onRetry,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await run(attempt);
    if (result.ok) {
      return result;
    }

    const canRetry =
      attempt < maxAttempts && shouldRetry(result.combinedOutput ?? "");
    if (!canRetry) {
      return result;
    }

    await onRetry?.(attempt, result);
    await wait(waitMs);
  }

  throw new Error("retry loop exhausted unexpectedly");
}

function defaultWait(delay) {
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

function commandName(binary) {
  return process.platform === "win32" ? `${binary}.cmd` : binary;
}

async function runStreamingCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      const combinedOutput = `${stdout}\n${stderr}`.trim();
      resolve({
        ok: code === 0,
        code: code ?? 1,
        signal,
        stdout,
        stderr,
        combinedOutput,
      });
    });
  });
}

async function runCheckedCommand(command, args, options = {}) {
  const result = await runStreamingCommand(command, args, options);
  if (!result.ok) {
    process.exit(result.code ?? 1);
  }
}

async function cleanElectronReleaseDir() {
  await rm(ELECTRON_RELEASE_DIR, { force: true, recursive: true });
}

async function main() {
  const builderArgs = process.argv.slice(2);
  const distArgs =
    builderArgs.length > 0 ? ["dist", ...builderArgs] : ["dist", "--mac", "--arm64"];
  const electronEnv = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY:
      process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false",
    ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? "/tmp/electron-cache",
  };

  await runCheckedCommand("node", ["./scripts/bump-electron-version.mjs"]);
  await runCheckedCommand(commandName("pnpm"), ["build"]);

  const result = await runWithRetries({
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    waitMs: DEFAULT_WAIT_MS,
    shouldRetry: isRetriableHdiutilResizeBusyError,
    onRetry: async (attempt, runResult) => {
      process.stderr.write(
        `\nTransient DMG resize failure detected (attempt ${attempt}/${DEFAULT_MAX_ATTEMPTS}). Retrying electron packaging in ${DEFAULT_WAIT_MS / 1000}s.\n`,
      );
      if (runResult.code != null) {
        process.stderr.write(`Previous exit code: ${runResult.code}\n`);
      }
    },
    run: async () => {
      await cleanElectronReleaseDir();
      return runStreamingCommand(commandName("pnpm"), distArgs, {
        cwd: ELECTRON_DIR,
        env: electronEnv,
      });
    },
  });

  if (!result.ok) {
    process.exit(result.code ?? 1);
  }
}

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
