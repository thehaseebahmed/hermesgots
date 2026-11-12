import { execSync } from "node:child_process"
import path from "node:path"
import { sentryVitePlugin } from "@sentry/vite-plugin"
import { reticle } from "@reticlehq/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { VitePWA } from "vite-plugin-pwa"

import pkg from "./package.json" with { type: "json" }
import { MERMAID } from "./src/lib/mermaid-chunks.ts"

/** mermaid's own packages: the door the app opens it through, and everything behind that door. */
const MERMAID_PACKAGE = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:mermaid|@mermaid-js)\//

/**
 * mermaid's chunks are emitted under `assets/mermaid/`, each keeping its own file, so the service
 * worker can leave that path out of the install and hold it in one cache-first route instead: both
 * need a path, and a hashed file name changes with every mermaid release. They cannot be forced into
 * one chunk, because each diagram type is a lazy import of its own and one file would preload them all.
 *
 * A chunk is mermaid's for either of two reasons. It carries a module of mermaid's own packages — the
 * door the diagram opens — which is also the chunk that may hold a helper mermaid shares with the
 * app. Or nothing in it can be reached from the app's entry without passing through those packages:
 * mermaid's layout libraries, its parser's dist, katex and cytoscape live in chunks of their own and
 * nowhere else in the app. That second question is answered here, where the module graph is finished,
 * because `chunkFileNames` is asked about one chunk at a time with no sight of it; every module the
 * entry reaches is marked, no edge out of mermaid's packages is followed, and the rest is mermaid's.
 */
function mermaidChunks() {
  const only = new Set<string>()

  const plugin: Plugin = {
    name: "gots:mermaid-chunks",
    buildEnd() {
      only.clear()
      const ids = Array.from(this.getModuleIds())
      const reached = new Set<string>()
      const queue: string[] = []
      for (const id of ids) {
        if (!this.getModuleInfo(id)?.isEntry) continue
        reached.add(id)
        queue.push(id)
      }
      while (queue.length) {
        const info = this.getModuleInfo(queue.pop() as string)
        if (!info) continue
        for (const next of [...info.importedIds, ...info.dynamicallyImportedIds]) {
          if (reached.has(next) || MERMAID_PACKAGE.test(next)) continue
          reached.add(next)
          queue.push(next)
        }
      }
      for (const id of ids) if (!reached.has(id)) only.add(id)
    },
  }

  return {
    plugin,
    // Every other chunk keeps exactly the name Vite gives it today.
    fileNames: (chunk: { moduleIds: string[] }) =>
      chunk.moduleIds.some((id) => MERMAID_PACKAGE.test(id)) ||
      (chunk.moduleIds.length > 0 && chunk.moduleIds.every((id) => only.has(id)))
        ? `${MERMAID}[name]-[hash].js`
        : "assets/[name]-[hash].js",
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
  const mermaid = mermaidChunks()

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
          // mermaid is fetched the first time a diagram is drawn and kept by the route below, so
          // precaching it would land ~5 MB on every reader at install — including one who never opens
          // a diagram. The gate reads this out of the built worker (`check-mermaid-chunks.mjs`).
          globIgnores: [`${MERMAID}**`],
          navigateFallback: "/index.html",
          // Netlify Identity, the sync function and the app's sign-in page must always reach the network.
          navigateFallbackDenylist: [/^\/\.netlify\//, /^\/auth\//],
          // Never let the service worker touch calls to the Hermes server. mermaid's chunks are the
          // one thing cached from this origin: same-origin `.js` under the build's own path for it,
          // held from the first diagram on so a diagram drawn once draws again with no connection.
          // Workbox tests a RegExp against the whole URL and takes a partial match only from this
          // origin, so a third party's copy of the path is never answered from this cache.
          runtimeCaching: [
            {
              // The path the build names these chunks by, read out of the one module that says it:
              // every slash escaped, so workbox writes the same expression it did by hand.
              urlPattern: new RegExp(`\\/${MERMAID.replaceAll("/", "\\/")}[^/]+\\.js$`),
              handler: "CacheFirst",
              options: {
                cacheName: "gots-mermaid",
                // The whole of mermaid is 89 files this release: 120 holds a build's closure with
                // room for one that grows, and still caps what a device spends on diagrams. Thirty
                // days keeps a diagram offline through a holiday, and lets go of a build this device
                // never comes back to — the same thirty days `canvas-css.ts` keeps a version's CSS.
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
  }
})
