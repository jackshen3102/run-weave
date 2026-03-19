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
      command: `PORT=${E2E_BACKEND_PORT} FRONTEND_ORIGIN=${E2E_FRONTEND_ORIGIN} pnpm --filter ./backend dev`,
      port: E2E_BACKEND_PORT,
      reuseExistingServer: true,
      cwd: "..",
    },
    {
      command: `VITE_API_BASE_URL=${E2E_API_BASE} pnpm --filter ./frontend dev --host 127.0.0.1 --port ${E2E_FRONTEND_PORT}`,
      port: E2E_FRONTEND_PORT,
      reuseExistingServer: true,
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
