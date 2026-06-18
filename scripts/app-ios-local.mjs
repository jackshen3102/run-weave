import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  resolvePort,
  startBackend,
  stopProcesses,
  waitForBackendReady,
  watchProcesses,
} from "../dev.mjs";

const DEFAULT_BACKEND_PORT = 5001;
const BACKEND_HOST = process.env.DEV_HOST?.trim() || "127.0.0.1";
const CAPACITOR_ORIGIN = "capacitor://localhost";
const EXISTING_BACKEND_HEALTHCHECK_TIMEOUT_MS = 1_000;

function resolveDesktopProfileDir() {
  return path.join(
    os.homedir(),
    ".runweave",
    "browser-profile",
    createHash("sha256").update("/").digest("hex").slice(0, 8),
  );
}

function appendConfiguredOrigin(rawOrigins, origin) {
  const origins = new Set(
    (rawOrigins ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  origins.add(origin);
  return Array.from(origins).join(",");
}

function runIosOpen(env) {
  const child = spawn("pnpm", ["--filter", "@runweave/app", "ios:open"], {
    env,
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `ios:open failed (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  });
}

async function readBackendHealth(backendUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    EXISTING_BACKEND_HEALTHCHECK_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${backendUrl}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json().catch(() => ({}));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  const defaultBackendUrl = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
  const existingBackendHealth = await readBackendHealth(defaultBackendUrl);
  const shouldReuseExistingBackend = existingBackendHealth !== null;
  const backendPort = shouldReuseExistingBackend
    ? DEFAULT_BACKEND_PORT
    : await resolvePort(DEFAULT_BACKEND_PORT, {
        host: BACKEND_HOST,
      });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const env = {
    ...process.env,
    FRONTEND_ORIGIN: appendConfiguredOrigin(
      process.env.FRONTEND_ORIGIN,
      CAPACITOR_ORIGIN,
    ),
    RUNWEAVE_DEV_BROWSER_PROFILE_DIR:
      process.env.RUNWEAVE_DEV_BROWSER_PROFILE_DIR?.trim() ||
      process.env.BROWSER_PROFILE_DIR?.trim() ||
      resolveDesktopProfileDir(),
  };

  console.log(`[app-ios-local] backend url: ${backendUrl}`);
  console.log(`[app-ios-local] allowed origin: ${CAPACITOR_ORIGIN}`);
  console.log(
    `[app-ios-local] backend profile: ${env.RUNWEAVE_DEV_BROWSER_PROFILE_DIR}`,
  );

  if (shouldReuseExistingBackend) {
    console.log(
      `[app-ios-local] reusing existing backend on ${backendUrl}: ${JSON.stringify(existingBackendHealth)}`,
    );
    console.log("[app-ios-local] syncing iOS app...");
    await runIosOpen({
      ...process.env,
      VITE_RUNWEAVE_API_BASE: backendUrl,
    });
    console.log(
      "[app-ios-local] Xcode opened. Run the app in an iOS simulator; keep the existing backend running.",
    );
    return;
  }

  const backend = startBackend({ host: BACKEND_HOST, backendPort, env });

  try {
    await waitForBackendReady(backend, backendUrl);
    console.log("[app-ios-local] backend ready, syncing iOS app...");
    await runIosOpen({
      ...process.env,
      VITE_RUNWEAVE_API_BASE: backendUrl,
    });
  } catch (error) {
    await stopProcesses([backend]);
    throw error;
  }

  console.log(
    "[app-ios-local] Xcode opened. Run the app in an iOS simulator; keep this process running for the local backend.",
  );
  await watchProcesses([backend], { logPrefix: "[app-ios-local]" });
}

const isDirectExecution =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  run().catch((error) => {
    console.error("[app-ios-local] failed", error);
    process.exit(1);
  });
}
