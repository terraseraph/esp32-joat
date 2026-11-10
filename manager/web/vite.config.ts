import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SERVER = "http://127.0.0.1:5180";

// One config for dev, build and vitest (`vite --config web/vite.config.ts`, run from manager/).
export default defineConfig({
  root: here("."),
  plugins: [react()],
  resolve: {
    // Server types shared with the web app: `import type { HealthResponse } from "@shared/api"`.
    alias: { "@shared": here("../server/src/types") },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [here("..")] },
    proxy: {
      // changeOrigin rewrites Host to the server's own address, which the localhost Host check requires.
      "/api": { target: SERVER, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: here("dist"), emptyOutDir: true, chunkSizeWarningLimit: 900 },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
