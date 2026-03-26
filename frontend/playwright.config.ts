import { defineConfig, devices } from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_FRONTEND_PORT = 4273;
const E2E_FRONTEND_ORIGIN = `http://127.0.0.1:${E2E_FRONTEND_PORT}`;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: E2E_FRONTEND_ORIGIN,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `PORT=${E2E_BACKEND_PORT} FRONTEND_ORIGIN=${E2E_FRONTEND_ORIGIN} AUTH_USERNAME=e2e-admin AUTH_PASSWORD=e2e-secret AUTH_JWT_SECRET=e2e-jwt-secret SESSION_RESTORE_ENABLED=false BROWSER_PROFILE_DIR=/tmp/browser-viewer-e2e-profile SESSION_DB_FILE=/tmp/browser-viewer-e2e-session.db node --import ./backend/node_modules/tsx/dist/loader.mjs backend/src/index.ts`,
      port: E2E_BACKEND_PORT,
      reuseExistingServer: false,
      cwd: "..",
    },
    {
      command: `VITE_API_BASE_URL=${E2E_API_BASE} pnpm --filter ./frontend dev --host 127.0.0.1 --port ${E2E_FRONTEND_PORT}`,
      port: E2E_FRONTEND_PORT,
      reuseExistingServer: false,
      cwd: "..",
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
