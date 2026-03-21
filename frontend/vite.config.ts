import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const frontendPort = Number(process.env.VITE_DEV_PORT ?? 5173);
const frontendHost = process.env.VITE_DEV_HOST?.trim() || "0.0.0.0";
const backendTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:5000";

export default defineConfig({
  plugins: [react()],
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
