import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here("."),
  plugins: [react()],
  resolve: { alias: { "@shared": here("../server/src/types") } },
  server: { port: 5284, strictPort: true, fs: { allow: [here("..")] }, proxy: { "/api": { target: "http://127.0.0.1:5285", changeOrigin: true, ws: true } } },
});
