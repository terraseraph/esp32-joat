import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL(".", import.meta.url))

const stub = fileURLToPath(new URL("./src/stub-viewer.tsx", import.meta.url))

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    // @tscircuit/3d-viewer nests its own three@0.165 while jscad-electronics uses the top-level
    // copy; two copies break the 3D view ("material.onBuild is not a function"), so force one.
    dedupe: ["three", "react", "react-dom"],
    alias: {
      "@tscircuit/system-block-viewer": stub,
      "@tscircuit/drawing-viewer": stub,
      "circuit-json-to-altium": stub,
      "circuit-json-to-step": stub,
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3101" },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 6000 },
})
