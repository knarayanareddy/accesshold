import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4100";

export default defineConfig({
  base: "/accesshold/",
  // public/media symlinks to docs/media without publishing other docs at the site root.
  publicDir: "./public",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      "/mcp": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
