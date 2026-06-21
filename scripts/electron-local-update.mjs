import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const appName = process.env.RUNWEAVE_LOCAL_UPDATE_APP_NAME ?? "Runweave";
const appPath =
  process.env.RUNWEAVE_LOCAL_UPDATE_APP_PATH ?? `/Applications/${appName}.app`;
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

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);

  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}`,
    );
  }
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
  await wait(3_000);
}

async function openApp() {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    await fs.access(appPath);
    await runChecked("open", [appPath]);
  } catch {
    await runChecked("open", ["-a", appName]);
  }
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
  await openApp();
  console.log(`[local-update] done`);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
