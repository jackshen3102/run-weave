import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const appName = process.env.RUNWEAVE_LOCAL_UPDATE_APP_NAME ?? "Runweave";
const appPath =
  process.env.RUNWEAVE_LOCAL_UPDATE_APP_PATH ?? `/Applications/${appName}.app`;
const releaseAppPath =
  process.env.RUNWEAVE_LOCAL_UPDATE_SOURCE_APP_PATH ??
  path.join(
    workspaceRoot,
    "electron",
    "release",
    "mac-arm64",
    `${appName}.app`,
  );
const feedUrl = withTrailingSlash(
  process.env.BROWSER_VIEWER_LOCAL_UPDATES_URL ??
    "http://127.0.0.1:5500/updates/mac/",
);
const feedCheckUrl = new URL("latest-mac.yml", feedUrl).toString();

function commandName(binary) {
  return process.platform === "win32" ? `${binary}.cmd` : binary;
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ ok: code === 0, code: code ?? 1, signal });
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);

  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}`,
    );
  }
}

async function getRunningAppLines() {
  const result = await runCapture("pgrep", ["-fl", appName]);

  if (!result.ok && result.code !== 1) {
    throw new Error(`pgrep failed with exit code ${result.code}`);
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes(`${appName}.app/Contents/`));
}

async function waitForAppExit() {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    if ((await getRunningAppLines()).length === 0) {
      return;
    }

    await wait(1_000);
  }

  const remaining = await getRunningAppLines();
  if (remaining.length > 0) {
    console.warn("[local-update] force stopping remaining Runweave processes");
    await run("pkill", ["-f", `${appName}.app/Contents/`]);
  }

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if ((await getRunningAppLines()).length === 0) {
      return;
    }

    await wait(1_000);
  }

  throw new Error(`${appName} did not exit cleanly`);
}

async function waitForInstalledAppStart() {
  const expectedMarker = `${appPath}/Contents/`;

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const runningLines = await getRunningAppLines();
    if (runningLines.some((line) => line.includes(expectedMarker))) {
      return;
    }

    await wait(1_000);
  }

  throw new Error(`${appName} did not start from ${appPath}`);
}

function requestFeed(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(
      parsed,
      { method: "GET", timeout: 2_000 },
      (response) => {
        response.resume();
        const statusCode = response.statusCode ?? 500;
        resolve(statusCode >= 200 && statusCode < 400);
      },
    );

    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

async function waitForFeed() {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (await requestFeed(feedCheckUrl)) {
      return true;
    }

    await wait(1_000);
  }

  return false;
}

async function quitApp() {
  if (process.platform !== "darwin") {
    return;
  }

  await run("osascript", ["-e", `tell application "${appName}" to quit`]);
  await waitForAppExit();
}

async function installBuiltApp() {
  if (process.platform !== "darwin") {
    return;
  }

  await fs.access(releaseAppPath);

  const appDir = path.dirname(appPath);
  const tempAppPath = path.join(
    appDir,
    `.${appName}.app.updating-${Date.now()}`,
  );

  console.log(`[local-update] installing ${releaseAppPath} to ${appPath}`);
  await fs.rm(tempAppPath, { force: true, recursive: true });
  await runChecked("ditto", [releaseAppPath, tempAppPath]);
  await run("xattr", ["-dr", "com.apple.quarantine", tempAppPath]);
  await fs.rm(appPath, { force: true, recursive: true });
  await fs.rename(tempAppPath, appPath);
}

async function openApp() {
  if (process.platform !== "darwin") {
    return;
  }

  await fs.access(appPath);
  await runChecked("open", ["-n", appPath]);
  await waitForInstalledAppStart();
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("electron local updates are only supported on macOS");
  }

  console.log(`[local-update] workspace: ${workspaceRoot}`);
  console.log(`[local-update] publishing local update artifacts`);
  await runChecked(commandName("pnpm"), ["publish:electron:local-updates"]);

  const feedAvailable = await waitForFeed();

  if (!feedAvailable) {
    console.warn(
      `[local-update] ${feedCheckUrl} is not reachable; make sure pnpm serve:electron:local-updates is running`,
    );
  }

  console.log(`[local-update] restarting ${appName}`);
  await quitApp();
  await installBuiltApp();
  await openApp();
  console.log(`[local-update] done`);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
