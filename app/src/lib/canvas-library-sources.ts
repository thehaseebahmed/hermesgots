/**
 * The libraries a canvas may ask for by name, as the sources the app inlines into the page
 * (`canvas-catalogue.ts` holds the names these answer, and `canvas-document.ts` answers an ask with
 * one of them).
 *
 * The page is drawn with no network and a policy that allows no connection, so a library is only
 * ever the one the app already ships: these are read out of the app's own dependencies, as text,
 * each behind its own `import("…?raw")` so Vite emits it as a chunk of its own. A page that asks for
 * chart fetches Chart.js and nothing else; a chat that opens no canvas fetches none of them.
 *
 * Two libraries are not the files their package ships: `src/lib/generated/` holds three's IIFE and
 * Leaflet's inlined stylesheet and marker setup, which `scripts/build-canvas-libraries.mjs` writes
 * before a test or a build. A library may carry a stylesheet and a setup as well as its source, and
 * the document puts them where they belong — the stylesheet in the head, the setup right after the
 * source (`CanvasLibrarySource`).
 *
 * `loadLibraries` is the rule a page's asks are answered by, and it imports nothing — it is handed
 * the loader, so `scripts/test-canvas-library-sources.mjs` drives it with a fake one.
 */

import type { CanvasLibrary } from "@/lib/canvas-catalogue"
import type { CanvasLibrarySource } from "@/lib/canvas-document"

/**
 * One thunk per name the catalogue carries. The specifier is a literal inside a dynamic import,
 * which is what tells Vite to emit that library as a chunk of its own rather than into the route's —
 * and what keeps every source out of the bytes a canvas that asks for none downloads.
 */
export const LIBRARY_SOURCES: Record<CanvasLibrary, () => Promise<CanvasLibrarySource>> = {
  // chart.js's exports map does not publish dist/, so the file is reached by path.
  chart: () =>
    import("../../node_modules/chart.js/dist/chart.umd.min.js?raw").then((one) => ({
      script: one.default,
    })),
  date: () => import("dayjs/dayjs.min.js?raw").then((one) => ({ script: one.default })),
  icons: () => import("lucide/dist/umd/lucide.min.js?raw").then((one) => ({ script: one.default })),
  // d3's exports map names its UMD file `umd` and nothing else, so the file is reached by path.
  d3: () =>
    import("../../node_modules/d3/dist/d3.min.js?raw").then((one) => ({ script: one.default })),
  alpine: () => import("@alpinejs/csp/dist/cdn.min.js?raw").then((one) => ({ script: one.default })),
  // three's package is ESM only, so what is read here is the IIFE the build made of it.
  three: () => import("./generated/three.js?raw").then((one) => ({ script: one.default })),
  // Leaflet's stylesheet names its images relative to itself, which a srcdoc page resolves nowhere,
  // and its JavaScript names the default marker's — so the build inlines one and pre-fixes the other.
  leaflet: async () => {
    const [script, css, setup] = await Promise.all([
      import("leaflet/dist/leaflet.js?raw"),
      import("./generated/leaflet.css?raw"),
      import("./generated/leaflet-setup.js?raw"),
    ])
    return { script: script.default, css: css.default, setup: setup.default }
  },
}

/**
 * The source a page's ask is answered with, by the name the page chose — which may be one this build
 * does not carry, or one the table merely inherits (`constructor`), so the lookup is the table's own.
 * A name with no source is a rejection, which `loadLibraries` reads as that library absent.
 */
export function librarySource(name: string): Promise<CanvasLibrarySource> {
  const source = Object.hasOwn(LIBRARY_SOURCES, name)
    ? LIBRARY_SOURCES[name as CanvasLibrary]
    : undefined
  return source
    ? source()
    : Promise.reject(new Error(`This build carries no library named ${name}.`))
}

/**
 * The sources for the names a page asked for (`canvasLibraryPlan`), fetched together and answered by
 * name: a name the page asked twice is fetched once, and a loader that throws — an unknown name, or
 * a chunk that never arrived — leaves that one library out, so a page draws without it rather than
 * not at all. Names are fetched in the order asked, and only those asked: a page that named none
 * fetches nothing and is drawn as it stands.
 */
export async function loadLibraries(
  names: readonly string[],
  load: (name: string) => Promise<CanvasLibrarySource>,
): Promise<Record<string, CanvasLibrarySource>> {
  const asked = [...new Set(names)]
  const sources = await Promise.all(
    asked.map(async (name) => {
      try {
        return [name, await load(name)] as const
      } catch (error) {
        // The page draws without this library, so the console is the only trace a reader's device
        // can leave: a chunk a deploy moved, or a phone that went offline mid-open, would otherwise
        // look like a library the build never carried.
        console.warn(`canvas: ${name} didn't load`, error)
        return null
      }
    }),
  )
  const loaded: Record<string, CanvasLibrarySource> = {}
  for (const one of sources) if (one) loaded[one[0]] = one[1]
  return loaded
}
