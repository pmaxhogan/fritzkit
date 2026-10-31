/**
 * Vite config for the fritzkit ui app (src/ui). `npm run ui:build` writes dist/ui, which
 * `fritzkit ui` serves. `npm run ui:dev` runs the app with hot reload and mounts the same
 * /api handler as `fritzkit ui` inside the Vite dev server (workspace from
 * $FRITZKIT_WORKSPACE or ~/fritzkit/parts), so no second process is needed.
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL("./src/ui", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/ui", import.meta.url));

/** Dev only: serve /api from src/server through Vite's SSR loader (TypeScript, no build). */
function fritzkitApi(): Plugin {
  return {
    name: "fritzkit-api",
    apply: "serve",
    async configureServer(server) {
      const mod = (await server.ssrLoadModule(
        fileURLToPath(new URL("./src/server/index.ts", import.meta.url)),
      )) as typeof import("./src/server/index.js");
      const api = await mod.createServer({ ctx: { env: process.env } });
      server.httpServer?.once("close", () => void api.close());
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        void api.handle(req, res);
      });
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  plugins: [react(), fritzkitApi()],
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
  },
  server: { host: "127.0.0.1", port: 5173 },
});
