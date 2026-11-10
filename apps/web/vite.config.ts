import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@brain/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3737" } },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 700 },
});
