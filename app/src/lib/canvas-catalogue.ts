/**
 * The libraries a canvas may ask for by name: the one list the app's sources, the guide's block and
 * the host's refusal are all read from (ADR 0147).
 *
 * A page asks with an empty `<script data-canvas-lib="NAME"></script>`, and an entry here is what
 * the app can answer that ask with — its source read out of the app's own dependencies, since the
 * page has no network and a policy that allows no connection (ADR 0114). The name a page names and
 * the name a source defines are different things, so both are here.
 *
 * Import-free, and holding no source text of its own: a name, a path and a number. The bytes live in
 * `canvas-library-sources.ts`, which is what a page's ask is answered from, so this reads as data to
 * everything that only needs the list — `scripts/test-canvas-document.mjs`, and the two artifacts
 * `scripts/build-canvas-catalogue.mjs` writes from it: the guide's library block and the host's
 * `libraries.json`.
 *
 * An entry carries what the guide has to say about it too — the name it is called by, and the
 * expression a page writes to use it — because a block hand-written beside this list is the copy
 * that drifts. Adding a library is one entry here and one run of the build (ADR 0147).
 */

/** One library the app carries: what a page asks for, what the app imports, and what it costs. */
interface CanvasLibraryEntry {
  /** The name a page asks by, as `data-canvas-lib` carries it. */
  name: string
  /** The library's own name, as the guide calls it: Chart.js, Day.js, lucide. */
  label: string
  /** The npm package the source ships in. */
  package: string
  /** Where in that package the browser build is, as the app's own import reaches it. */
  source: string
  /** The global a page reads once the source has run. */
  global: string
  /**
   * What the guide tells a page to write once the source has run: the global itself, or the entry
   * point that takes a call (`lucide.createIcons()`), so a library whose use is more than a name is
   * still one entry and no special case in the block's composition.
   */
  call?: string
  /** The source's size in bytes, measured from the file the app inlines. */
  bytes: number
  /**
   * A stylesheet the source needs, where it ships one the page has to be given: the path
   * `canvas-library-sources.ts` reads it from, which the document puts in the page's head.
   */
  css?: string
  /**
   * A prelude that runs after the source and before the page's own scripts — what a library's own
   * JavaScript expects and no stylesheet can say — as the path it is read from.
   */
  setup?: string
  /** One clause the guide adds after the global, where the global alone would mislead. */
  hint?: string
}

/**
 * The library's own order, which is the order the guide names them in. Chart.js and d3 are UMD and
 * need no preparation; Day.js and lucide are the same globals a CDN would have handed the page, and
 * Alpine's CDN build is an IIFE that starts itself, so no call is taught for it either. Chart.js's
 * and d3's exports maps do not publish a path to `dist/`, so their files are reached by path.
 */
export const CATALOGUE = [
  {
    name: "chart",
    label: "Chart.js",
    package: "chart.js",
    source: "node_modules/chart.js/dist/chart.umd.min.js",
    global: "Chart",
    bytes: 210_082,
  },
  {
    name: "date",
    label: "Day.js",
    package: "dayjs",
    source: "dayjs/dayjs.min.js",
    global: "dayjs",
    bytes: 7_161,
  },
  {
    name: "icons",
    label: "lucide",
    package: "lucide",
    source: "lucide/dist/umd/lucide.min.js",
    global: "lucide",
    call: "lucide.createIcons()",
    bytes: 481_206,
  },
  {
    name: "d3",
    label: "d3",
    package: "d3",
    source: "node_modules/d3/dist/d3.min.js",
    global: "d3",
    bytes: 280_622,
  },
  {
    // The CDN build is an IIFE that names `window.Alpine` and starts itself on a microtask, so a
    // page writes markup and no call: teaching `Alpine.start()` here would be the second start the
    // build warns about, not a step the page owes.
    name: "alpine",
    label: "Alpine.js",
    // The CSP build, not the standard one: Alpine evaluates directive expressions with `new
    // Function`, and the frame's policy allows no `unsafe-eval`, so the standard build throws on
    // every directive. This build interprets them instead, which is what a page can run here — at
    // the cost of expressions being simple names or `Alpine.data` components.
    package: "@alpinejs/csp",
    source: "@alpinejs/csp/dist/cdn.min.js",
    global: "Alpine",
    hint: "components via `Alpine.data`",
    bytes: 72_242,
  },
  {
    // No build of three names a global any more, so the app bundles its ESM entry into one IIFE
    // under `THREE` — the file inlined here, whose first line says the version it came from.
    name: "three",
    label: "Three.js",
    package: "three",
    source: "src/lib/generated/three.js",
    global: "THREE",
    bytes: 749_736,
  },
  {
    // A srcdoc page resolves a relative URL nowhere, so the stylesheet's three images are `data:`
    // URIs and the two more its JavaScript draws are the same URIs in the setup prelude — the
    // default marker's icon, its retina image and its shadow are named by JS, not by CSS.
    name: "leaflet",
    label: "Leaflet",
    package: "leaflet",
    source: "leaflet/dist/leaflet.js",
    global: "L",
    bytes: 147_552,
    css: "src/lib/generated/leaflet.css",
    setup: "src/lib/generated/leaflet-setup.js",
  },
] as const satisfies readonly CanvasLibraryEntry[]

/** Every name a page may ask for, derived from the catalogue rather than kept beside it. */
export type CanvasLibrary = (typeof CATALOGUE)[number]["name"]

/** Those names as a list, in the catalogue's order. */
export const LIBRARIES: readonly CanvasLibrary[] = CATALOGUE.map((library) => library.name)
