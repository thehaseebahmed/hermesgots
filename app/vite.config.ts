import { execSync } from "node:child_process"
import path from "node:path"
import { sentryVitePlugin } from "@sentry/vite-plugin"
import { reticle } from "@reticlehq/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { VitePWA } from "vite-plugin-pwa"

import pkg from "./package.json" with { type: "json" }
import {
  MERMAID,
  MERMAID_PACKAGE,
  mermaidChunks,
  type MermaidSplit,
} from "./src/lib/mermaid-chunks.ts"

/**
 * Names mermaid's chunks with the one rule in `src/lib/mermaid-chunks.ts`: a chunk carrying a module
 * of mermaid's own packages, or reached by the module `import("mermaid")` names, lands under
 * `MERMAID` — outside the precache and behind the one cache-first route. The gate asks the same rule
 * of the built worker, which is what makes the two of them one rule rather than two opinions.
 */
function mermaidChunksPlugin() {
  let split: MermaidSplit | undefined

  const plugin: Plugin = {
    name: "gots:mermaid-chunks",
    buildEnd() {
      const ids = Array.from(this.getModuleIds())
      const reaches = (id: string) => {
        const info = this.getModuleInfo(id)
        return info ? [...info.importedIds, ...info.dynamicallyImportedIds] : []
      }
      // The door is what `import("mermaid")` names: the module of mermaid's packages that a module
      // outside them imports. There is one, and a second would have to be named here.
      const doors = [
        ...new Set(
          ids
            .filter((id) => !MERMAID_PACKAGE.test(id))
            .flatMap((id) => reaches(id).filter((next) => MERMAID_PACKAGE.test(next))),
        ),
      ]
      if (doors.length !== 1)
        this.error(
          `one module imports mermaid, found ${doors.length}: ${doors.join(", ") || "none"}`,
        )
      split = mermaidChunks({
        nodes: ids,
        reaches,
        carries: (id) => MERMAID_PACKAGE.test(id),
        door: doors[0],
        entry: ids.filter((id) => this.getModuleInfo(id)?.isEntry),
      })
    },
  }

  return {
    plugin,
    fileNames: (chunk: { moduleIds: string[] }) => {
      // A chunk is named once the graph is whole, which is what `buildEnd` is for.
      if (!split) throw new Error("mermaid's chunks are named before buildEnd ran")
      return split.names(chunk.moduleIds) ? `${MERMAID}[name]-[hash].js` : "assets/[name]-[hash].js"
    },
  }
}

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

const version = `${pkg.version} · ${commit()}`

// Source maps are built and uploaded only where a token can pay for them, and the files are dropped
// after the upload so the deploy serves no readable source. A build without the token is unchanged.
const uploads = Boolean(process.env.SENTRY_AUTH_TOKEN)

export default defineConfig(({ mode }) => {
  const mermaid = mermaidChunksPlugin()

  return {
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    build: {
      sourcemap: uploads,
      rolldownOptions: { output: { chunkFileNames: mermaid.fileNames } },
    },
    plugins: [
      mermaid.plugin,
      uploads &&
        sentryVitePlugin({
          org: "tha-org",
          project: "gots-app",
          authToken: process.env.SENTRY_AUTH_TOKEN,
          // The same string the app reports as its release, so a stack lands on the build it came from.
          release: { name: version },
          sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
          telemetry: false,
        }),
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
            {
              src: "maskable-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
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
          globIgnores: [`${MERMAID}**`],
          navigateFallback: "/index.html",
          // Netlify Identity, the sync function and the app's sign-in page must always reach the network.
          navigateFallbackDenylist: [/^\/\.netlify\//, /^\/auth\//],
          // Never let the service worker touch calls to the Hermes server. The one route below is
          // mermaid's, and workbox takes a partial RegExp match only from this origin, so a third
          // party's copy of the path is never answered from this cache.
          runtimeCaching: [
            {
              // A RegExp's source escapes its slashes, so the path is escaped as it goes in.
              urlPattern: new RegExp(`\\/${MERMAID.replaceAll("/", "\\/")}[^/]+\\.js$`),
              handler: "CacheFirst",
              options: {
                cacheName: "gots-mermaid",
                expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
                cacheableResponse: { statuses: [200] },
              },
            },
          ],
          // Shows the plugin's pushes and takes shares; see public/push-sw.js and share-sw.js.
          importScripts: ["push-sw.js", "share-sw.js"],
        },
      }),
    ],
    resolve: {
      alias: { "@": path.resolve(import.meta.dirname, "./src") },
    },
    // The style guide reads the repository's DESIGN.md, one level above the app.
    server: { fs: { allow: [".."] } },
  }
})
