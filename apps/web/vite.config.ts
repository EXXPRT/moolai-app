import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The page calls its gateway same-origin at /api: api/index.py on Vercel, `npm run demo:api` locally.
const gateway = "http://127.0.0.1:8787";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  // 5174, not the desktop renderer's 5173, so both dev servers can run at once.
  server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: { "/api": gateway } },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true, proxy: { "/api": gateway } },
  build: { outDir: "dist", emptyOutDir: true },
});
