import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const ELECTRON_DIR = path.join(ROOT, "electron");
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function resolveDefaultCacheRoot() {
  const homeDir = os.homedir();
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Caches");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local"),
      "Cache",
    );
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homeDir, ".cache"));
}

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

function takeBuilderConfig(builderArgs) {
  const remaining = [];
  let config = "electron-builder.yml";
  for (let index = 0; index < builderArgs.length; index += 1) {
    const arg = builderArgs[index];
    if (arg === "--config") {
      config = builderArgs[index + 1] ?? config;
      index += 1;
    } else if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length);
    } else {
      remaining.push(arg);
    }
  }
  return { config, remaining };
}

async function prepareIsolatedBuild(buildRoot, baseBuilderConfig, env) {
  const frontendDist = path.join(buildRoot, "frontend", "dist");
  const electronAppDir = path.join(buildRoot, "electron");
  const electronDist = path.join(electronAppDir, "dist");
  const releaseDir = path.join(buildRoot, "release");
  await rm(buildRoot, { force: true, recursive: true });
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });
  await runCheckedCommand(
    commandName("pnpm"),
    ["-C", "frontend", "exec", "vite", "build", "--outDir", frontendDist],
    { cwd: ROOT, env },
  );
  await runCheckedCommand(
    "node",
    ["scripts/prepare-better-sqlite3-runtime.mjs"],
    { cwd: ELECTRON_DIR, env },
  );
  await runCheckedCommand("node", ["scripts/bundle.mjs"], {
    cwd: ELECTRON_DIR,
    env: { ...env, RUNWEAVE_ELECTRON_BUNDLE_OUTDIR: electronDist },
  });
  const appPackage = JSON.parse(
    await readFile(path.join(ELECTRON_DIR, "package.json"), "utf8"),
  );
  appPackage.dependencies = {};
  delete appPackage.devDependencies;
  await writeFile(
    path.join(electronAppDir, "package.json"),
    `${JSON.stringify(appPackage, null, 2)}\n`,
    { mode: 0o600 },
  );
  const configPath = path.join(buildRoot, "electron-builder.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        afterPack: path.join(ELECTRON_DIR, "scripts", "adhoc-sign-mac.js"),
        extends: path.resolve(ELECTRON_DIR, baseBuilderConfig),
        directories: {
          app: electronAppDir,
          buildResources: path.join(ELECTRON_DIR, "resources"),
          output: releaseDir,
        },
        files: [
          {
            from: electronAppDir,
            to: ".",
            filter: ["package.json", "dist/**/*"],
          },
          {
            from: path.join(ELECTRON_DIR, "resources"),
            to: "resources",
            filter: ["**/*", "!icons/raw/**/*"],
          },
        ],
        extraResources: [
          { from: frontendDist, to: "frontend/dist", filter: ["**/*"] },
          {
            from: path.join(
              ROOT,
              "backend",
              "node_modules",
              "node-pty",
            ),
            to: "backend/node_modules/node-pty",
            filter: [
              "lib/**/*",
              "prebuilds/darwin-arm64/**/*",
              "package.json",
              "LICENSE",
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { configPath, releaseDir };
}

async function main() {
  const parsedBuilder = takeBuilderConfig(process.argv.slice(2));
  const builderArgs = parsedBuilder.remaining;
  if (process.env.RUNWEAVE_ELECTRON_BUILD_VERSION) {
    builderArgs.push(
      `--config.extraMetadata.version=${process.env.RUNWEAVE_ELECTRON_BUILD_VERSION}`,
      `--config.extraMetadata.buildVersion=${process.env.RUNWEAVE_ELECTRON_BUILD_VERSION}`,
    );
  }
  if (process.env.RUNWEAVE_LOCAL_UPDATE_APP_NAME) {
    builderArgs.push(
      `--config.productName=${process.env.RUNWEAVE_LOCAL_UPDATE_APP_NAME}`,
    );
  }
  if (process.env.RUNWEAVE_ELECTRON_APP_ID) {
    builderArgs.push(`--config.appId=${process.env.RUNWEAVE_ELECTRON_APP_ID}`);
  }
  const defaultCacheRoot = resolveDefaultCacheRoot();
  const electronEnv = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY:
      process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false",
    ELECTRON_CACHE:
      process.env.ELECTRON_CACHE ?? path.join(defaultCacheRoot, "electron"),
    ELECTRON_BUILDER_CACHE:
      process.env.ELECTRON_BUILDER_CACHE ??
      path.join(defaultCacheRoot, "electron-builder"),
  };
  const isolatedBuildRoot = process.env.RUNWEAVE_ELECTRON_BUILD_ROOT?.trim();
  let releaseDir = path.join(ELECTRON_DIR, "release");

  if (process.env.RUNWEAVE_SKIP_ELECTRON_VERSION_BUMP !== "true") {
    await runCheckedCommand("node", ["./scripts/bump-electron-version.mjs"]);
  }
  if (isolatedBuildRoot) {
    const isolated = await prepareIsolatedBuild(
      path.resolve(isolatedBuildRoot),
      parsedBuilder.config,
      electronEnv,
    );
    releaseDir = isolated.releaseDir;
    builderArgs.unshift("--config", isolated.configPath);
  } else {
    await runCheckedCommand(commandName("pnpm"), ["build"]);
    builderArgs.unshift("--config", parsedBuilder.config);
  }
  const distArgs = ["dist", ...builderArgs];

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
      await rm(releaseDir, { force: true, recursive: true });
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
