import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import pkg from "../package.json" with { type: "json" }

/**
 * Storybook's own build config: React, Tailwind and the app's alias, and nothing else. The app's
 * `vite.config.ts` also carries the service worker, Sentry's upload and the dev verification SDK, none
 * of which belong in a component workshop.
 */
export default defineConfig({
  // The two build-time constants the app's own config defines.
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version}-storybook`),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../src") } },
  // The Foundations stories read the repository's DESIGN.md, one level above the app.
  server: { fs: { allow: [path.resolve(import.meta.dirname, "../..")] } },
})
