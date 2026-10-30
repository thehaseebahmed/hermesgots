import { execSync } from "node:child_process"
import path from "node:path"
import { reticle } from "@reticlehq/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

import pkg from "./package.json" with { type: "json" }

function commit() {
  // Netlify exposes the deployed commit; fall back to git locally.
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7)
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
  } catch {
    return "dev"
  }
}

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version} · ${commit()}`),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    // Dev-only: the Reticle verification SDK's build plugin (see the Dockerfile). It stamps source
    // locations and injects the connect call while the dev server runs, and is inert in a build.
    reticle(),
    react(),
    tailwindcss(),
    VitePWA({
      // The Android app ships its assets in the APK; a service worker would only serve stale ones.
      disable: mode === "native",
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "apple-touch-icon.png", "bots/*.png"],
      manifest: {
        name: "Gots",
        short_name: "Gots",
        description: "A playful companion app for your Hermes Agent.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // Android's share sheet (Chrome, once installed) takes any file here; see share-sw.js.
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [
              {
                name: "media",
                accept: ["image/*", "video/*", "audio/*", "text/*", "application/*"],
              },
            ],
          },
        },
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        // Netlify Identity, the sync function and the app's sign-in page must always reach the network.
        navigateFallbackDenylist: [/^\/\.netlify\//, /^\/auth\//],
        // Never let the service worker touch calls to the Hermes server.
        runtimeCaching: [],
        // Shows the plugin's pushes and takes shares; see public/push-sw.js and share-sw.js.
        importScripts: ["push-sw.js", "share-sw.js"],
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
}))
