import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "PORT=3100 FRONTEND_ORIGIN=http://127.0.0.1:4173 pnpm --filter ./backend dev",
      port: 3100,
      reuseExistingServer: true,
      cwd: "..",
    },
    {
      command: "VITE_API_BASE_URL=http://127.0.0.1:3100 pnpm --filter ./frontend dev -- --host 127.0.0.1 --port 4173",
      port: 4173,
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
