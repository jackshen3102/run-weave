import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:5001";

const frontendPort = Number(process.env.VITE_DEV_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port: frontendPort,
    strictPort: false,
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
    },
  },
});
