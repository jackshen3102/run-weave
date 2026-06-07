import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appPort = Number(process.env.VITE_DEV_PORT ?? 5174);
const appHost = process.env.VITE_DEV_HOST?.trim() || "127.0.0.1";
const backendTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:5001";
const strictPort = process.env.VITE_STRICT_PORT === "true";

export default defineConfig({
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
    },
  },
});
