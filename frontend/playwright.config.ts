import { defineConfig, devices } from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_FRONTEND_PORT = 4273;
const E2E_FRONTEND_ORIGIN = `http://127.0.0.1:${E2E_FRONTEND_PORT}`;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
const E2E_TMUX_DIR = `/tmp/browser-viewer-e2e-tmux-${process.pid}-${Date.now()}`;
const E2E_TMUX_SOCKET_PATH = `${E2E_TMUX_DIR}/runweave.tmux.sock`;
const E2E_HOOK_TOKEN = "e2e-hook-token";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: E2E_FRONTEND_ORIGIN,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `mkdir -p ${E2E_TMUX_DIR} && trap 'tmux -S ${E2E_TMUX_SOCKET_PATH} kill-server >/dev/null 2>&1 || true; rm -rf ${E2E_TMUX_DIR}' EXIT INT TERM; rm -f /tmp/browser-viewer-e2e-auth.json /tmp/browser-viewer-e2e-session.json /tmp/browser-viewer-e2e-terminal-session.json && PORT=${E2E_BACKEND_PORT} FRONTEND_ORIGIN=${E2E_FRONTEND_ORIGIN} AUTH_USERNAME=e2e-admin AUTH_PASSWORD=e2e-secret AUTH_JWT_SECRET=e2e-jwt-secret RUNWEAVE_HOOK_TOKEN=${E2E_HOOK_TOKEN} SESSION_RESTORE_ENABLED=false BROWSER_PROFILE_DIR=/tmp/browser-viewer-e2e-profile AUTH_STORE_FILE=/tmp/browser-viewer-e2e-auth.json SESSION_STORE_FILE=/tmp/browser-viewer-e2e-session.json TERMINAL_SESSION_STORE_FILE=/tmp/browser-viewer-e2e-terminal-session.json TERMINAL_TMUX_SOCKET_PATH=${E2E_TMUX_SOCKET_PATH} TERMINAL_TMUX_SCAN_ORPHANS_ON_START=true node --import ./backend/node_modules/tsx/dist/loader.mjs backend/src/index.ts`,
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
