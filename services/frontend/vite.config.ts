import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxyTarget = process.env.VITE_DEV_PROXY_TARGET ?? "http://localhost:4000";
const websocketProxyTarget = proxyTarget.replace(/^http/i, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/auth": proxyTarget,
      "/orders": proxyTarget,
      "/health": proxyTarget,
      "/ready": proxyTarget,
      "/ws": {
        target: websocketProxyTarget,
        ws: true
      }
    }
  },
  preview: {
    host: "0.0.0.0",
    port: 4173
  }
});
