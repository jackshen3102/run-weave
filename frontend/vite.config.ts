import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const frontendPort = Number(process.env.VITE_DEV_PORT ?? 5173);
const frontendHost = process.env.VITE_DEV_HOST?.trim() || "0.0.0.0";
const backendTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:5000";

export default defineConfig({
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
  ],
  server: {
    host: frontendHost,
    port: frontendPort,
    strictPort: true,
    proxy: {
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
    },
  },
});
