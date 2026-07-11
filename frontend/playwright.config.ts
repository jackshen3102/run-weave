import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const backendPort = Number(process.env.PLAYWRIGHT_BACKEND_PORT ?? 5610);
const frontendPort = Number(process.env.PLAYWRIGHT_FRONTEND_PORT ?? 5611);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const profileDir =
  process.env.PLAYWRIGHT_PROFILE_DIR ??
  path.join(os.tmpdir(), `runweave-playwright-${process.pid}`);

if (!process.env.PLAYWRIGHT_PROFILE_DIR) {
  rmSync(profileDir, { force: true, recursive: true });
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  outputDir: "../artifacts/playwright/test-results",
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: "../artifacts/playwright/html-report",
      },
    ],
  ],
  use: {
    baseURL: frontendUrl,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --dir ../backend start",
      cwd: frontendDir,
      env: {
        ...process.env,
        AUTH_COOKIE_SECURE: "false",
        AUTH_JWT_SECRET: "runweave-playwright-jwt-secret",
        AUTH_PASSWORD: "runweave-e2e-password",
        AUTH_USERNAME: "runweave-e2e",
        BROWSER_PROFILE_DIR: profileDir,
        ELECTRON_RUN_AS_NODE: "",
        HOST: "127.0.0.1",
        PORT: String(backendPort),
        PORT_STRICT: "true",
        RUNWEAVE_RUNTIME_RELEASE_ID: "",
        SESSION_RESTORE_ENABLED: "false",
      },
      reuseExistingServer: false,
      timeout: 60_000,
      url: `${backendUrl}/health`,
    },
    {
      command: `pnpm dev -- --host 127.0.0.1 --port ${frontendPort}`,
      cwd: frontendDir,
      env: {
        ...process.env,
        VITE_API_BASE_URL: "",
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: String(frontendPort),
        VITE_PROXY_TARGET: backendUrl,
      },
      reuseExistingServer: false,
      timeout: 60_000,
      url: frontendUrl,
    },
  ],
});
