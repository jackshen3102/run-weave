import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

import { buildInfoDefine } from "../scripts/lib/build-info.mjs";
import { publishComponentArtifact } from "../scripts/release/component-artifact.mjs";
import path from "node:path";

const frontendPort = Number(process.env.VITE_DEV_PORT ?? 5173);
const frontendHost = process.env.VITE_DEV_HOST?.trim() || "0.0.0.0";
const backendTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:5000";
const expectedBackendId =
  process.env.VITE_RUNWEAVE_EXPECTED_BACKEND_ID?.trim() || null;

export default defineConfig(({ command }) => {
  const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
  let outputDirectory = "";
  let buildSucceeded = false;
  return {
    define: command === "serve" ? buildInfoDefine(packageDirectory) : {},
    plugins: [
      react(),
      VitePWA({
        // Registration is wired manually in src/pwa.ts so Electron/custom
        // protocol loads can skip service worker registration.
        injectRegister: null,
        includeManifestIcons: false,
        registerType: "prompt",
        manifest: false,
        workbox: {
          globPatterns: [],
          navigateFallback: null,
          runtimeCaching: [
            {
              urlPattern: /\/manifest\.webmanifest$/,
              handler: "NetworkOnly",
              method: "GET",
            },
          ],
        },
      }),
      {
        name: "runweave-component-version",
        apply: "build",
        configResolved(config) {
          outputDirectory = path.resolve(config.root, config.build.outDir);
        },
        buildEnd(error) {
          buildSucceeded = !error;
        },
        closeBundle: {
          order: "post",
          sequential: true,
          async handler() {
            if (!buildSucceeded) return;
            await publishComponentArtifact({
              component: `web-${process.env.VITE_RUNWEAVE_CHANNEL === "beta" ? "beta" : "stable"}`,
              packageDirectory,
              roots: [{ name: "web", directory: outputDirectory }],
              metadataFile: path.join(outputDirectory, "build-info.json"),
              htmlEntries: ["index.html", "companion.html"].map((name) =>
                path.join(outputDirectory, name),
              ),
            });
          },
        },
      },
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        input: {
          companion: fileURLToPath(
            new URL("./companion.html", import.meta.url),
          ),
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
        },
      },
    },
    server: {
      host: frontendHost,
      port: frontendPort,
      strictPort: true,
      proxy: {
        ...(expectedBackendId
          ? {
              "/health": {
                target: backendTarget,
                changeOrigin: true,
              },
            }
          : {}),
        "/share/terminal": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/api": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/ws": {
          target: backendTarget,
          ws: true,
          changeOrigin: true,
        },
        "/devtools": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/prototype-preview": {
          target: backendTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
