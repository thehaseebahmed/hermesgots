/**
 * The libraries a canvas may ask for by name: the one list the app's sources, the guide's block and
 * the host's refusal are all read from (ADR 0146).
 *
 * A page asks with an empty `<script data-canvas-lib="NAME"></script>`, and an entry here is what
 * the app can answer that ask with — its source read out of the app's own dependencies, since the
 * page has no network and a policy that allows no connection (ADR 0114). The name a page names and
 * the name a source defines are different things, so both are here.
 *
 * Import-free, and holding no source text of its own: a name, a path and a number. The bytes live in
 * `canvas-library-sources.ts`, which is what a page's ask is answered from, so this reads as data to
 * everything that only needs the list — `scripts/test-canvas-document.mjs` today, the guide's block
 * and the host's `libraries.json` next.
 */

/** One library the app carries: what a page asks for, what the app imports, and what it costs. */
interface CanvasLibraryEntry {
  /** The name a page asks by, as `data-canvas-lib` carries it. */
  name: string
  /** The npm package the source ships in. */
  package: string
  /** Where in that package the browser build is, as the app's own import reaches it. */
  source: string
  /** The global a page reads once the source has run. */
  global: string
  /** The source's size in bytes, measured from the file the app inlines. */
  bytes: number
  /** A stylesheet the source needs, where it ships one the page has to be given. */
  css?: string
  /** A prelude that runs after the source and before the page's own scripts. */
  setup?: string
}

/**
 * The library's own order, which is the order the guide names them in. Chart.js is UMD and needs no
 * preparation; Day.js and lucide are the same globals a CDN would have handed the page. Chart.js's
 * exports map does not publish `dist/`, so its file is reached by path.
 */
export const CATALOGUE = [
  {
    name: "chart",
    package: "chart.js",
    source: "node_modules/chart.js/dist/chart.umd.min.js",
    global: "Chart",
    bytes: 210_082,
  },
  {
    name: "date",
    package: "dayjs",
    source: "dayjs/dayjs.min.js",
    global: "dayjs",
    bytes: 7_161,
  },
  {
    name: "icons",
    package: "lucide",
    source: "lucide/dist/umd/lucide.min.js",
    global: "lucide",
    bytes: 481_206,
  },
] as const satisfies readonly CanvasLibraryEntry[]

/** Every name a page may ask for, derived from the catalogue rather than kept beside it. */
export type CanvasLibrary = (typeof CATALOGUE)[number]["name"]

/** Those names as a list, in the catalogue's order. */
export const LIBRARIES: readonly CanvasLibrary[] = CATALOGUE.map((library) => library.name)
