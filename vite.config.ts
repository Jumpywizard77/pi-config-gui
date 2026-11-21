import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The UI lives inside this package: `index.html` at the project root with
 * `src/ui` as the app directory (no nested package). Output goes to
 * `dist/ui` — relative to the project ROOT, which is what the CLI serves by
 * default (the brief's "../dist/ui" assumed a nested layout).
 */
export default defineConfig({
  // Relative asset URLs: the CLI serves the build from an arbitrary port/dir.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/ui",
  },
  server: {
    // Dev mode (`npm run dev:ui`): the SPA talks to the API on this same
    // origin; Vite forwards /api to the server started with
    // `node dist/cli.js --port 8711 --no-open` (8711 so a pi-config-gui dev
    // server can coexist with opencode-config-gui's 8710).
    proxy: {
      "/api": "http://127.0.0.1:8711",
    },
  },
});
