import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appPort = Number(process.env.VITE_DEV_PORT ?? 5174);
const appHost = process.env.VITE_DEV_HOST?.trim() || "127.0.0.1";
const backendTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:5001";
const strictPort = process.env.VITE_STRICT_PORT === "true";
const appDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(appDir, "..");

function readAppVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };

  return typeof packageJson.version === "string"
    ? packageJson.version
    : "0.0.0";
}

function readGitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "nogit";
  }
}

function createAppBuildId(): string {
  const configuredBuildId =
    process.env.RUNWEAVE_APP_BUILD_ID?.trim() ||
    process.env.VITE_RUNWEAVE_APP_BUILD_ID?.trim();
  if (configuredBuildId) {
    return configuredBuildId;
  }

  const timestamp = new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${readGitSha()}-${timestamp}`;
}

const appVersion = readAppVersion();
const appBuildId = createAppBuildId();

export default defineConfig({
  define: {
    "import.meta.env.VITE_RUNWEAVE_APP_BUILD_ID": JSON.stringify(appBuildId),
    "import.meta.env.VITE_RUNWEAVE_APP_VERSION": JSON.stringify(appVersion),
  },
  plugins: [react()],
  server: {
    host: appHost,
    port: appPort,
    strictPort,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/health": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/ws": {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
